import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import type {
  GatewayPool,
  GatewayListenerSettings,
  GatewayUpstream,
  GatewayUpstreamHealth,
  OmpProvider,
} from "@omp-switch/core";
import { credentialIdFromApiKey } from "@omp-switch/core/credential-references";
import { ModelPicker } from "../../components/model-picker";
import { IconButton, StyledSelect, Tip } from "../../components/ui-primitives";
import { ConfirmDialog } from "../../components/save-flow";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatClock } from "../../locale";

type AppApi = NonNullable<Window["ompSwitch"]>;
type Notice = { tone: "success" | "error" | "info"; text: string };
type ProbeOutcome = { ok: boolean; status?: number; latencyMs?: number; error?: string };

interface GatewayProps {
  api: AppApi;
  profileId: string;
  readOnly: boolean;
  onNotice: (notice: Notice) => void;
  providers: Array<[string, OmpProvider]>;
}

function makeGatewayUpstream(providerId: string, modelId: string, credentialId?: string): GatewayUpstream {
  return { id: `upstream-${crypto.randomUUID()}`, providerId, modelId, kind: "secret", credentialId, enabled: true };
}

function makeGatewayPool(profileId: string, providers: Array<[string, OmpProvider]>): GatewayPool {
  const first = providers[0];
  const model = first && Array.isArray(first[1].models) ? first[1].models[0] : undefined;
  const providerId = first?.[0] ?? "";
  const modelId = model?.id ?? "";
  const upstream = makeGatewayUpstream(providerId, modelId, credentialIdFromApiKey(first?.[1].apiKey));
  return { id: `pool-${Date.now().toString(36)}`, profile: profileId, virtualModel: "omp-switch/default", enabled: true, upstreams: [upstream] };
}

export function GatewayModule(props: GatewayProps): ReactElement {
  return <ProfileGatewayModule key={props.profileId} {...props} />;
}

function ProfileGatewayModule({ api, profileId, readOnly, onNotice, providers }: GatewayProps): ReactElement {
  const { t } = useTranslation();
  const [pools, setPools] = useState<GatewayPool[]>([]);
  const [draft, setDraft] = useState<GatewayPool | null>(null);
  const [listenerSettings, setListenerSettings] = useState<GatewayListenerSettings | null>(null);
  const [portInput, setPortInput] = useState("");
  const [upstreamRowKeys] = useState(() => new WeakMap<GatewayUpstream, string>());
  const [status, setStatus] = useState<Awaited<ReturnType<AppApi["gatewayStatus"]>>>({ running: false, profileId: null, port: null, upstreams: [] });
  const token = status.running && status.profileId === profileId ? status.token : undefined;
  const [healthMap, setHealthMap] = useState<Record<string, GatewayUpstreamHealth>>({});

  const [loading, setLoading] = useState(false);
  const [probingAll, setProbingAll] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ profile: string; id: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const modelOptions = useMemo(() => providers.flatMap(([providerId, provider]) => (Array.isArray(provider.models) ? provider.models : []).map((model) => ({ providerId, modelId: model.id, label: `${providerId}/${model.id}` }))), [providers]);
  const savedPool = pools.find((pool) => pool.id === draft?.id);
  const draftVersion = useMemo(() => JSON.stringify(draft), [draft]);
  const savedVersion = useMemo(() => JSON.stringify(savedPool), [savedPool]);
  const canProbe = Boolean(savedPool && draftVersion === savedVersion);
  const port = Number(portInput);
  const validPort = portInput.trim() !== "" && Number.isInteger(port) && port >= 1024 && port <= 65535;
  const portSaved = listenerSettings?.port !== null && listenerSettings?.port !== undefined && validPort && port === listenerSettings.port;
  const portLocked = status.running && status.profileId === profileId;

  function clearToken(): void {
    setStatus((current) => current.token === undefined ? current : { ...current, token: undefined });
  }

  async function refreshStatus(): Promise<void> {
    clearToken();
    const current = await api.gatewayStatus(profileId);
    setStatus(current);
  }

  async function refresh(): Promise<void> {
    clearToken();
    setLoading(true);
    try {
      setPools(await api.listGatewayPools(profileId));
      const settings = await api.gatewayListenerSettings(profileId);
      setListenerSettings(settings);
      setPortInput(settings.port === null ? "" : String(settings.port));
      await refreshStatus();
      const health = await api.gatewayHealth(profileId);
      setHealthMap(health);
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [profileId]);

  async function savePort(): Promise<void> {
    if (readOnly || portLocked || !validPort) return;
    setLoading(true);
    try {
      const settings = await api.setGatewayPort(profileId, port);
      setListenerSettings(settings);
      setPortInput(settings.port === null ? "" : String(settings.port));
      onNotice({ tone: "success", text: t("gateway.portSaved", { profile: profileId }) });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  function updateDraft<K extends keyof GatewayPool>(key: K, value: GatewayPool[K]): void {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function openDraft(pool: GatewayPool): void {
    for (const upstream of pool.upstreams) {
      if (!upstreamRowKeys.has(upstream)) upstreamRowKeys.set(upstream, crypto.randomUUID());
    }
    setDraft(pool);
  }

  function updateUpstream(index: number, patch: Partial<GatewayUpstream>): void {
    setDraft((current) => current ? { ...current, upstreams: current.upstreams.map((upstream, itemIndex) => {
      if (itemIndex !== index) return upstream;
      const updated = { ...upstream, ...patch };
      if (patch.providerId !== undefined || patch.modelId !== undefined || patch.kind !== undefined) {
        const provider = providers.find(([id]) => id === updated.providerId)?.[1];
        updated.credentialId = updated.kind === "secret" ? credentialIdFromApiKey(provider?.apiKey) : undefined;
      }
      upstreamRowKeys.set(updated, upstreamRowKeys.get(upstream)!);
      return updated;
    }) } : current);
  }

  function addUpstream(): void {
    const upstream = makeGatewayUpstream(providers[0]?.[0] ?? "", modelOptions[0]?.modelId ?? "", credentialIdFromApiKey(providers[0]?.[1].apiKey));
    upstreamRowKeys.set(upstream, crypto.randomUUID());
    setDraft((current) => current ? { ...current, upstreams: [...current.upstreams, upstream] } : current);
  }

  function moveUpstream(index: number, direction: "up" | "down"): void {
    setDraft((current) => {
      if (!current) return current;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= current.upstreams.length) return current;
      const next = [...current.upstreams];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return { ...current, upstreams: next };
    });
  }

  async function saveDraft(): Promise<GatewayPool | null> {
    if (!draft || draft.profile !== profileId) return null;
    if (!draft.id.trim() || !draft.virtualModel.trim()) return onNotice({ tone: "error", text: t("gateway.poolIdVirtualModelRequired") }), null;
    const upstreamIds = new Set<string>();
    for (const upstream of draft.upstreams) {
      if (upstream.kind === "secret" && !upstream.credentialId) return onNotice({ tone: "error", text: t("gateway.credentialMissing") }), null;
      if (upstreamIds.has(upstream.id)) return onNotice({ tone: "error", text: t("gateway.duplicateUpstreamId", { id: upstream.id }) }), null;
      upstreamIds.add(upstream.id);
    }
    setLoading(true);
    try {
      const saved = await api.saveGatewayPool({ ...draft, id: draft.id.trim(), virtualModel: draft.virtualModel.trim() });
      setPools((current) => [saved, ...current.filter((pool) => pool.id !== saved.id)]);
      openDraft(saved);
      setProbeRun(null);
      setHealthMap((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${saved.id}:`))));
      onNotice({ tone: "success", text: t("gateway.poolSaved", { profile: profileId }) });
      return saved;
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function deletePool(): Promise<void> {
    if (!deleteTarget || deleting || loading || isProbing || readOnly) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      await api.deleteGatewayPool(target.profile, target.id);
      setPools((current) => current.filter((pool) => pool.id !== target.id));
      setDraft((current) => current?.profile === target.profile && current.id === target.id ? null : current);
      setHealthMap((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${target.id}:`))));
      setProbeRun(null);
      setStatus((current) => ({ ...current, upstreams: current.upstreams.filter((stat) => stat.poolId !== target.id) }));
      setDeleteTarget(null);
      onNotice({ tone: "success", text: t("gateway.poolDeleted", { profile: target.profile, pool: target.id }) });
      await refreshStatus();
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeleting(false);
    }
  }

  async function start(): Promise<void> {
    if (readOnly) return onNotice({ tone: "error", text: t("gateway.readonly") });
    if (!portSaved) return onNotice({ tone: "info", text: t("gateway.portSaveFirst") });
    clearToken();
    const saved = await saveDraft();
    if (!saved) {
      await refreshStatus().catch((error) => onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
      return;
    }
    setLoading(true);
    try {
      const started = await api.startGateway(profileId);
      setStatus({ running: started.running, profileId: started.profileId, port: started.port, upstreams: [], token: started.token });
      onNotice({ tone: "success", text: t("gateway.started", { profile: started.profileId, port: started.port }) });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      await refreshStatus().catch((refreshError) => onNotice({ tone: "error", text: refreshError instanceof Error ? refreshError.message : String(refreshError) }));
    } finally {
      setLoading(false);
    }
  }

  const [probingUpstreamId, setProbingUpstreamId] = useState<string | null>(null);
  const [probeRun, setProbeRun] = useState<{ version: string; results: Record<string, ProbeOutcome> } | null>(null);
  const probeResults = canProbe && probeRun && probeRun.version === draftVersion ? probeRun.results : undefined;
  const isProbing = probingUpstreamId !== null || probingAll;

  const activeProbeRun = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => {
    if (activeProbeRun.current) activeProbeRun.current.cancelled = true;
  }, []);

  async function verifyProbeVersion(pool: GatewayPool, run: { cancelled: boolean }): Promise<boolean> {
    if (run.cancelled) return false;
    const currentPools = await api.listGatewayPools(profileId);
    if (run.cancelled) return false;
    if (JSON.stringify(currentPools.find((candidate) => candidate.id === pool.id)) === JSON.stringify(pool)) return true;
    setPools(currentPools);
    onNotice({ tone: "error", text: t("gateway.probeConfigurationChanged") });
    return false;
  }

  async function probeSavedUpstream(pool: GatewayPool, upstream: GatewayUpstream, run: { cancelled: boolean }): Promise<ProbeOutcome> {
    const version = JSON.stringify(pool);
    let result: ProbeOutcome;
    try {
      result = await api.probeGatewayUpstream(profileId, pool.id, upstream.id, version);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!run.cancelled) {
      setProbeRun((current) => ({ version, results: { ...(current && current.version === version ? current.results : {}), [upstream.id]: result } }));
    }
    return result;
  }

  async function testProbe(upstream: GatewayUpstream): Promise<void> {
    if (activeProbeRun.current || isProbing || deleting || !upstream.enabled) return;
    if (!savedPool || !canProbe) return onNotice({ tone: "info", text: t("gateway.probeSaveFirst") });
    const pool = savedPool;
    const run = { cancelled: false };
    activeProbeRun.current = run;
    setProbingUpstreamId(upstream.id);
    try {
      if (!await verifyProbeVersion(pool, run)) return;
      const res = await probeSavedUpstream(pool, upstream, run);
      if (run.cancelled) return;
      onNotice(res.ok
        ? { tone: "success", text: t("gateway.probeSuccess", { pool: pool.id, id: upstream.id, latency: res.latencyMs }) }
        : { tone: "error", text: t("gateway.probeFailed", { pool: pool.id, id: upstream.id, error: res.error || "Error" }) });
      const updatedHealth = await api.gatewayHealth(profileId, pool.id);
      if (!run.cancelled) setHealthMap((current) => ({ ...current, ...updatedHealth }));
    } catch (error) {
      if (!run.cancelled) onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      activeProbeRun.current = null;
      if (!run.cancelled) setProbingUpstreamId(null);
    }
  }

  async function probeAll(): Promise<void> {
    if (activeProbeRun.current || isProbing || deleting) return;
    if (!savedPool || !canProbe) return onNotice({ tone: "info", text: t("gateway.probeSaveFirst") });
    const pool = savedPool;
    const targets = pool.upstreams.filter((upstream) => upstream.enabled);
    if (!targets.length) return onNotice({ tone: "info", text: t("gateway.probeNoneEnabled") });
    const run = { cancelled: false };
    activeProbeRun.current = run;
    setProbingAll(true);
    const failures: string[] = [];
    try {
      for (const upstream of targets) {
        if (!await verifyProbeVersion(pool, run)) return;
        setProbingUpstreamId(upstream.id);
        const res = await probeSavedUpstream(pool, upstream, run);
        if (run.cancelled) return;
        if (!res.ok) failures.push(`${upstream.id}: ${res.error || "Error"}`);
      }
      const counts = { pool: pool.id, count: targets.length, ok: targets.length - failures.length, failed: failures.length };
      onNotice(failures.length
        ? { tone: "error", text: `${t("gateway.probeAllFailed", counts)} ${failures.join("; ")}` }
        : { tone: "success", text: t("gateway.probeAllFinished", counts) });
      const updatedHealth = await api.gatewayHealth(profileId, pool.id);
      if (!run.cancelled) setHealthMap((current) => ({ ...current, ...updatedHealth }));
    } catch (error) {
      if (!run.cancelled) onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      activeProbeRun.current = null;
      if (!run.cancelled) {
        setProbingUpstreamId(null);
        setProbingAll(false);
      }
    }
  }

  async function stop(): Promise<void> {
    const expectedProfileId = status.profileId;
    if (!status.running || !expectedProfileId) return;
    setLoading(true);
    clearToken();
    try {
      await api.stopGateway(expectedProfileId);
      await refreshStatus();
      onNotice({ tone: "success", text: t("gateway.stopped", { profile: expectedProfileId }) });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      await refreshStatus().catch((refreshError) => onNotice({ tone: "error", text: refreshError instanceof Error ? refreshError.message : String(refreshError) }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="module-view module-shell">
      <div className="workspace-heading module-heading">
        <div>
          <span className="eyebrow">{profileId}</span>
          <h1>{t("gateway.heading")}<span className="heading-count">{pools.length}</span></h1>
        </div>
        <div className="heading-actions">
          <span className={`status-chip ${status.running ? "ok" : "neutral"}`}>
            {status.running ? t("gateway.running", { profile: status.profileId, port: status.port }) : t("gateway.stoppedBadge")}
          </span>
          {status.running ? (
            <button className="secondary-button" onClick={() => void stop()} disabled={loading || deleting || isProbing}>
              <Square size={14} />{t("gateway.stop", { profile: status.profileId })}
            </button>
          ) : null}
          <IconButton label={t("common.refresh")} onClick={() => void refresh()} disabled={loading || deleting || isProbing}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </IconButton>
          {pools.length > 0 ? (
            <button className="primary-button" onClick={() => openDraft(makeGatewayPool(profileId, providers))} disabled={readOnly}>
              <Plus size={16} />{t("common.add")}
            </button>
          ) : null}
        </div>
      </div>
      <div className="gateway-connection">
        <div className="module-field gateway-port-setting">
          <label htmlFor="gateway-listener-port">{t("gateway.profilePort", { profile: profileId })}</label>
          <div className="gateway-port-controls">
            <input id="gateway-listener-port" name="listenerPort" inputMode="numeric" value={portInput} onChange={(event) => setPortInput(event.target.value)} disabled={loading || readOnly || portLocked || listenerSettings === null} aria-describedby="gateway-port-hint" aria-invalid={portInput !== "" && !validPort} />
            <button className="secondary-button" onClick={() => void savePort()} disabled={loading || deleting || readOnly || portLocked || !validPort || portSaved || listenerSettings === null}>
              <Save size={15} />{t("gateway.savePort")}
            </button>
          </div>
        </div>
        <p id="gateway-port-hint" className="muted-line" aria-live="polite">
          {t("gateway.portHint")}
          {listenerSettings?.port === null ? ` ${t("gateway.portUnresolved", { ports: listenerSettings.conflictingPorts.join(", ") || t("gateway.portUnknown") })}` : ""}
          {portInput !== "" && !validPort ? ` ${t("gateway.portInvalid")}` : ""}
          {!portSaved ? ` ${t("gateway.portSaveFirst")}` : ""}
          {portLocked ? ` ${t("gateway.portLocked")}` : ""}
        </p>
      </div>
      {token ? (
        <label className="module-field">
          <span>{t("gateway.bearerToken", { profile: status.profileId })}</span>
          <input name="bearerToken" className="mono" readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
        </label>
      ) : null}
      {pools.length === 0 && !draft ? (
        <div className="module-empty gateway-empty-state">
          <span className="empty-glyph"><CircleAlert size={26} /></span>
          <strong>{t("gateway.empty")}</strong>
          <span className="empty-desc">{t("gateway.emptyHint")}</span>
          <div className="empty-actions">
            <button className="primary-button" onClick={() => openDraft(makeGatewayPool(profileId, providers))} disabled={readOnly}>
              <Plus size={15} />{t("gateway.newPool")}
            </button>
          </div>
        </div>
      ) : (
      <div className={`gateway-layout${pools.length === 0 ? " gateway-layout--editor-only" : ""}`}>
        {pools.length > 0 ? <div className="module-list-panel">
          {pools.map((pool) => (
            <button key={pool.id} className={`module-list-row ${draft?.id === pool.id ? "active" : ""}`} onClick={() => openDraft(pool)}>
              <span className="module-row-main">
                <strong>{pool.virtualModel}</strong>
                <small>{pool.id} · {t("gateway.upstreamCount", { count: pool.upstreams.length })}</small>
              </span>
              <span className={`status-chip ${pool.enabled ? "ok" : "neutral"}`}>
                {pool.enabled ? t("gateway.enabled") : t("gateway.disabled")}
              </span>
            </button>
          ))}
        </div> : null}
        <div className="module-editor-panel gateway-editor">
          {draft ? (
            <>
              <div className="editor-head">
                <div>
                  <span className="eyebrow">{t("gateway.pool")}</span>
                  <strong>{draft.id}</strong>
                </div>
                <div className="drawer-actions">
                  {savedPool ? <button className="secondary-button danger" onClick={() => setDeleteTarget({ profile: profileId, id: savedPool.id })} disabled={loading || deleting || isProbing || readOnly}>
                    <Trash2 size={14} />{t("gateway.deletePool")}
                  </button> : null}
                  <button className="secondary-button" onClick={() => setDraft(null)}>{t("common.close")}</button>
                </div>
              </div>
              <label className="module-field">
                <span>{t("gateway.fieldId")}</span>
                <input name="poolId" value={draft.id} onChange={(event) => updateDraft("id", event.target.value)} disabled={Boolean(pools.find((pool) => pool.id === draft.id))} />
              </label>
              <label className="module-field">
                <span>{t("gateway.fieldVirtualModel")}</span>
                <input name="virtualModel" value={draft.virtualModel} onChange={(event) => updateDraft("virtualModel", event.target.value)} placeholder="omp-switch/default" />
              </label>
              <label className="check-line module-check">
                <input name="enabled" type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} />
                {t("gateway.enabled")}
              </label>
              <div className="upstream-list">
                <div className="drawer-section-title">
                  <span>{t("gateway.upstreams")}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      type="button"
                      className="secondary-button compact"
                      title={t("gateway.probeAll")}
                      onClick={() => void probeAll()}
                      disabled={loading || deleting || isProbing || !canProbe || !draft.upstreams.some((upstream) => upstream.enabled)}
                    >
                      <Activity size={13} className={probingAll ? "spin" : ""} />
                      <span>{t("gateway.probeAll")}</span>
                    </button>
                    <IconButton
                      label={t("gateway.addUpstream")}
                      onClick={addUpstream}
                    >
                      <Plus size={15} />
                    </IconButton>
                  </div>
                </div>
                <p className="muted-line" aria-live="polite">
                  {t(canProbe ? "gateway.probeSavedHint" : "gateway.probeSaveFirst")}
                  {canProbe && !draft.upstreams.some((upstream) => upstream.enabled) ? ` ${t("gateway.probeNoneEnabled")}` : ""}
                </p>
                {draft.upstreams.map((upstream, index) => {
                  const healthKey = `${draft.id}:${upstream.id}`;
                  const health = canProbe ? healthMap[healthKey] : undefined;
                  const probeResult = probeResults?.[upstream.id];
                  const healthState = probeResult ? (probeResult.ok ? "healthy" : "unhealthy") : health?.healthState ?? "untested";
                  const latency = probeResult ? probeResult.latencyMs : health?.lastLatencyMs;

                  return (
                    <div className="upstream-row" key={upstreamRowKeys.get(upstream)}>
                      <div className="upstream-header">
                        <div className="upstream-controls">
                          <div className="upstream-reorder-buttons">
                            <IconButton label={t("gateway.moveUpstreamUp")} variant="subtle" disabled={index === 0} onClick={() => moveUpstream(index, "up")}>
                              <ChevronUp size={13} />
                            </IconButton>
                            <IconButton label={t("gateway.moveUpstreamDown")} variant="subtle" disabled={index === draft.upstreams.length - 1} onClick={() => moveUpstream(index, "down")}>
                              <ChevronDown size={13} />
                            </IconButton>
                          </div>
                          <label className="check-line module-check">
                            <input name={`upstreams.${index}.enabled`} type="checkbox" aria-label={t("gateway.upstreamEnabled")} checked={upstream.enabled} onChange={(event) => updateUpstream(index, { enabled: event.target.checked })} />
                            {t(upstream.enabled ? "gateway.enabled" : "gateway.disabled")}
                          </label>
                        </div>
                        <div className="upstream-actions">
                          <IconButton
                            className={probeResult?.ok ? "ok" : ""}
                            variant="subtle"
                            label={t("gateway.probeUpstream")}
                            onClick={() => void testProbe(upstream)}
                            disabled={loading || deleting || isProbing || !canProbe || !upstream.enabled}
                          >
                            <Activity size={14} className={probingUpstreamId === upstream.id ? "spin" : ""} />
                          </IconButton>
                          <Tip
                            label={
                              <div className="tip-stack">
                                <span className="tip-stack-date">{t(`gateway.health.${healthState}`)}</span>
                                {health ? <span className="tip-stack-sub">{t("gateway.probeHistoryHint")}</span> : null}
                                {probeResult?.error ? <span className="tip-stack-sub">{probeResult.error}</span> : null}
                                {latency !== undefined ? (
                                  <span className="tip-stack-value">{latency} ms {probeResult?.status ? `(HTTP ${probeResult.status})` : ""}</span>
                                ) : null}
                                {health?.lastProbeAt ? (
                                  <span className="tip-stack-sub">{formatDateTime(health.lastProbeAt)}</span>
                                ) : null}
                                {health?.recentHistory && health.recentHistory.length > 0 ? (
                                  <div className="health-history-list">
                                    {health.recentHistory.slice(0, 5).map((h, i) => (
                                      <div key={i} className={`health-history-item ${h.ok ? "ok" : "err"}`}>
                                        <span>{h.ok ? "✓" : "✗"} {h.status ? `HTTP ${h.status}` : (h.error || "ERR")}</span>
                                        <span>{h.latencyMs}ms</span>
                                        <span>{formatClock(h.timestamp)}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            }
                          >
                            <span className={`health-badge ${healthState}`}>
                              <span className="status-led" />
                              <span>{!probeResult && health ? `${t("gateway.probeHistory")} · ` : ""}{latency !== undefined ? `${latency}ms` : t(probeResult && !probeResult.ok ? "gateway.probeError" : "gateway.untested")}</span>
                            </span>
                          </Tip>
                          <IconButton
                            variant="danger"
                            label={t("gateway.deleteUpstream")}
                            onClick={() => setDraft((current) => current ? { ...current, upstreams: current.upstreams.filter((_, itemIndex) => itemIndex !== index) } : current)}
                            disabled={draft.upstreams.length <= 1 || loading || deleting || isProbing || readOnly}
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </div>
                      <div className="upstream-fields">
                        <label className="module-field">
                          <span>{t("gateway.ariaUpstreamId")}</span>
                          <input name={`upstreams.${index}.id`} value={upstream.id} onChange={(event) => updateUpstream(index, { id: event.target.value })} aria-label={t("gateway.ariaUpstreamId")} />
                        </label>
                        <div className="module-field">
                          <span>{t("gateway.ariaProviderModel")}</span>
                          <ModelPicker
                            providers={providers}
                            value={upstream.providerId && upstream.modelId ? `${upstream.providerId}/${upstream.modelId}` : ""}
                            onValueChange={(next) => {
                              const slash = next.indexOf("/");
                              if (slash < 0) return;
                              updateUpstream(index, { providerId: next.slice(0, slash), modelId: next.slice(slash + 1) });
                            }}
                            ariaLabel={t("gateway.ariaProviderModel")}
                          />
                        </div>
                        <div className="module-field">
                          <span>{t("gateway.ariaAuthKind")}</span>
                          <StyledSelect
                            value={upstream.kind}
                            onValueChange={(next) => updateUpstream(index, { kind: next as GatewayUpstream["kind"] })}
                            options={[{ value: "secret", label: t("gateway.kindSecret") }, { value: "omp-auth-gateway", label: t("gateway.kindOmpAuth") }]}
                            ariaLabel={t("gateway.ariaAuthKind")}
                          />
                        </div>
                        <label className="module-field">
                          <span>{t("gateway.credentialId")}</span>
                          <input
                            name={`upstreams.${index}.credentialId`}
                            value={upstream.credentialId ?? ""}
                            readOnly
                            disabled={upstream.kind === "omp-auth-gateway"}
                            aria-invalid={upstream.kind === "secret" && !upstream.credentialId}
                            aria-describedby={`gateway-credential-${upstreamRowKeys.get(upstream)}`}
                            className="upstream-credential"
                            placeholder={t("gateway.credentialId")}
                            aria-label={t("gateway.credentialId")}
                          />
                          <small className="muted-line" id={`gateway-credential-${upstreamRowKeys.get(upstream)}`}>
                            {t(upstream.kind === "omp-auth-gateway" ? "gateway.credentialOAuth" : upstream.credentialId ? "gateway.credentialAutomatic" : "gateway.credentialMissing")}
                          </small>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="drawer-actions">
                <button className="primary-button" onClick={() => void saveDraft()} disabled={loading || deleting || readOnly || isProbing}>
                  <Save size={15} />{t("common.save")}
                </button>
                <button className="secondary-button" onClick={() => void start()} disabled={loading || deleting || readOnly || isProbing || !portSaved}>
                  <Play size={14} />{t(status.running && status.profileId !== profileId ? "gateway.switchProfile" : "gateway.start", { profile: profileId })}
                </button>
              </div>
              <p className="muted-line">{t("gateway.saveHint")}</p>
              {status.running && status.profileId === profileId && status.upstreams.length > 0 ? (
                <div className="upstream-list">
                  <div className="drawer-section-title">
                    <span>{t("gateway.upstreamStatus")}</span>
                  </div>
                  {status.upstreams.map((stat) => (
                    <div className="upstream-status-row" key={`${stat.poolId}:${stat.upstreamId}`}>
                      <span className="mono">{stat.upstreamId}</span>
                      <span className={`status-chip ${stat.consecutiveFailures > 0 ? "warn" : "ok"}`}>
                        {stat.lastStatus ?? "ERR"}
                      </span>
                      <span className="muted-line">{stat.lastLatencyMs !== undefined ? `${stat.lastLatencyMs} ms` : "—"}</span>
                      <span className="muted-line">
                        {stat.consecutiveFailures > 0 ? t("gateway.consecutiveFailures", { count: stat.consecutiveFailures }) : formatDateTime(stat.lastAt)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="module-empty compact-empty">
              <span className="empty-glyph"><CircleAlert size={26} /></span>
              <strong>{t("gateway.selectPrompt")}</strong>
              <span className="empty-desc">{t("gateway.selectHint")}</span>
            </div>
          )}
        </div>
      </div>
      )}
      <ConfirmDialog open={deleteTarget !== null} title={t("gateway.deletePoolTitle", { pool: deleteTarget?.id })} message={t("gateway.deletePoolWarning", { profile: deleteTarget?.profile })} confirmLabel={t("gateway.deletePool")} danger busy={deleting} onClose={() => { if (!deleting) setDeleteTarget(null); }} onConfirm={() => void deletePool()} />
    </section>
  );
}
