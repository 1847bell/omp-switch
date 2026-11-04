import { useEffect, useMemo, useState } from "react";
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
  GatewayUpstream,
  GatewayUpstreamHealth,
  GatewayUpstreamStat,
  OmpProvider,
} from "@omp-switch/core";
import { ModelPicker } from "../../components/model-picker";
import { IconButton, StyledSelect, Tip } from "../../components/ui-primitives";
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

function makeGatewayUpstream(providerId: string, modelId: string): GatewayUpstream {
  return { id: `upstream-${crypto.randomUUID()}`, providerId, modelId, kind: "secret", enabled: true };
}

function makeGatewayPool(profileId: string, providers: Array<[string, OmpProvider]>): GatewayPool {
  const first = providers[0];
  const model = first && Array.isArray(first[1].models) ? first[1].models[0] : undefined;
  const providerId = first?.[0] ?? "";
  const modelId = model?.id ?? "";
  const upstream = makeGatewayUpstream(providerId, modelId);
  return { id: `pool-${Date.now().toString(36)}`, profile: profileId, virtualModel: "omp-switch/default", port: 46831, enabled: true, upstreams: [upstream] };
}

export function GatewayModule(props: GatewayProps): ReactElement {
  return <ProfileGatewayModule key={props.profileId} {...props} />;
}

function ProfileGatewayModule({ api, profileId, readOnly, onNotice, providers }: GatewayProps): ReactElement {
  const { t } = useTranslation();
  const [pools, setPools] = useState<GatewayPool[]>([]);
  const [draft, setDraft] = useState<GatewayPool | null>(null);
  const [upstreamRowKeys] = useState(() => new WeakMap<GatewayUpstream, string>());
  const [status, setStatus] = useState<{ running: boolean; profileId: string | null; port: number | null; upstreams: GatewayUpstreamStat[] }>({ running: false, profileId: null, port: null, upstreams: [] });
  const [token, setToken] = useState<string | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, GatewayUpstreamHealth>>({});

  const [loading, setLoading] = useState(false);
  const [probingAll, setProbingAll] = useState(false);
  const modelOptions = useMemo(() => providers.flatMap(([providerId, provider]) => (Array.isArray(provider.models) ? provider.models : []).map((model) => ({ providerId, modelId: model.id, label: `${providerId}/${model.id}` }))), [providers]);
  const savedPool = pools.find((pool) => pool.id === draft?.id);
  const draftVersion = useMemo(() => JSON.stringify(draft), [draft]);
  const savedVersion = useMemo(() => JSON.stringify(savedPool), [savedPool]);
  const canProbe = Boolean(savedPool && draftVersion === savedVersion);

  async function refreshStatus(): Promise<void> {
    const current = await api.gatewayStatus();
    setStatus(current);
    if (!current.running || current.profileId !== profileId) setToken(null);
  }

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      setPools(await api.listGatewayPools(profileId));
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

  function updateDraft<K extends keyof GatewayPool>(key: K, value: GatewayPool[K]): void {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function openDraft(pool: GatewayPool): void {
    for (const upstream of pool.upstreams) upstreamRowKeys.set(upstream, crypto.randomUUID());
    setDraft(pool);
  }

  function updateUpstream(index: number, patch: Partial<GatewayUpstream>): void {
    setDraft((current) => current ? { ...current, upstreams: current.upstreams.map((upstream, itemIndex) => {
      if (itemIndex !== index) return upstream;
      const updated = { ...upstream, ...patch };
      upstreamRowKeys.set(updated, upstreamRowKeys.get(upstream)!);
      return updated;
    }) } : current);
  }

  function addUpstream(): void {
    const upstream = makeGatewayUpstream(providers[0]?.[0] ?? "", modelOptions[0]?.modelId ?? "");
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

  async function start(): Promise<void> {
    if (readOnly) return onNotice({ tone: "error", text: t("gateway.readonly") });
    setToken(null);
    const saved = await saveDraft();
    if (!saved) {
      await refreshStatus().catch((error) => onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
      return;
    }
    setLoading(true);
    try {
      const started = await api.startGateway(profileId);
      setStatus({ running: started.running, profileId: started.profileId, port: started.port, upstreams: [] });
      setToken(started.token);
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

  async function verifyProbeVersion(pool: GatewayPool): Promise<boolean> {
    const currentPools = await api.listGatewayPools(profileId);
    if (JSON.stringify(currentPools.find((candidate) => candidate.id === pool.id)) === JSON.stringify(pool)) return true;
    setPools(currentPools);
    onNotice({ tone: "error", text: t("gateway.probeConfigurationChanged") });
    return false;
  }

  async function probeSavedUpstream(pool: GatewayPool, upstream: GatewayUpstream): Promise<ProbeOutcome> {
    let result: ProbeOutcome;
    try {
      result = await api.probeGatewayUpstream(profileId, pool.id, upstream.id);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const version = JSON.stringify(pool);
    setProbeRun((current) => ({ version, results: { ...(current && current.version === version ? current.results : {}), [upstream.id]: result } }));
    return result;
  }

  async function testProbe(upstream: GatewayUpstream): Promise<void> {
    if (isProbing) return;
    if (!savedPool || !canProbe) return onNotice({ tone: "info", text: t("gateway.probeSaveFirst") });
    const pool = savedPool;
    setProbingUpstreamId(upstream.id);
    try {
      if (!await verifyProbeVersion(pool)) return;
      const res = await probeSavedUpstream(pool, upstream);
      onNotice(res.ok
        ? { tone: "success", text: t("gateway.probeSuccess", { pool: pool.id, id: upstream.id, latency: res.latencyMs }) }
        : { tone: "error", text: t("gateway.probeFailed", { pool: pool.id, id: upstream.id, error: res.error || "Error" }) });
      const updatedHealth = await api.gatewayHealth(profileId, pool.id);
      setHealthMap((current) => ({ ...current, ...updatedHealth }));
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProbingUpstreamId(null);
    }
  }

  async function probeAll(): Promise<void> {
    if (isProbing) return;
    if (!savedPool || !canProbe) return onNotice({ tone: "info", text: t("gateway.probeSaveFirst") });
    const pool = savedPool;
    const targets = pool.upstreams.filter((upstream) => upstream.enabled);
    if (!targets.length) return onNotice({ tone: "info", text: t("gateway.probeNoneEnabled") });
    setProbingAll(true);
    const failures: string[] = [];
    try {
      if (!await verifyProbeVersion(pool)) return;
      for (const upstream of targets) {
        setProbingUpstreamId(upstream.id);
        const res = await probeSavedUpstream(pool, upstream);
        if (!res.ok) failures.push(`${upstream.id}: ${res.error || "Error"}`);
      }
      const counts = { pool: pool.id, count: targets.length, ok: targets.length - failures.length, failed: failures.length };
      onNotice(failures.length
        ? { tone: "error", text: `${t("gateway.probeAllFailed", counts)} ${failures.join("; ")}` }
        : { tone: "success", text: t("gateway.probeAllFinished", counts) });
      const updatedHealth = await api.gatewayHealth(profileId, pool.id);
      setHealthMap((current) => ({ ...current, ...updatedHealth }));
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProbingUpstreamId(null);
      setProbingAll(false);
    }
  }

  async function stop(): Promise<void> {
    const expectedProfileId = status.profileId;
    if (!status.running || !expectedProfileId) return;
    setLoading(true);
    setToken(null);
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
            <button className="secondary-button" onClick={() => void stop()} disabled={loading}>
              <Square size={14} />{t("gateway.stop", { profile: status.profileId })}
            </button>
          ) : null}
          <IconButton label={t("common.refresh")} onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </IconButton>
          {pools.length > 0 ? (
            <button className="primary-button" onClick={() => openDraft(makeGatewayPool(profileId, providers))} disabled={readOnly}>
              <Plus size={16} />{t("common.add")}
            </button>
          ) : null}
        </div>
      </div>
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
                <small>{pool.id} · {t("gateway.upstreamCount", { count: pool.upstreams.length })} · {pool.port}</small>
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
                  <button className="secondary-button" onClick={() => setDraft(null)}>{t("common.close")}</button>
                </div>
              </div>
              <div className="form-two">
                <label className="module-field">
                  <span>{t("gateway.fieldId")}</span>
                  <input name="poolId" value={draft.id} onChange={(event) => updateDraft("id", event.target.value)} disabled={Boolean(pools.find((pool) => pool.id === draft.id))} />
                </label>
                <label className="module-field">
                  <span>{t("gateway.fieldPort")}</span>
                  <input name="poolPort" inputMode="numeric" value={draft.port} onChange={(event) => updateDraft("port", Number(event.target.value) || 0)} />
                </label>
              </div>
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
                      disabled={loading || isProbing || !canProbe || !draft.upstreams.some((upstream) => upstream.enabled)}
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
                      <div className="upstream-reorder-buttons">
                        <IconButton label={t("gateway.moveUpstreamUp")} variant="subtle" disabled={index === 0} onClick={() => moveUpstream(index, "up")}>
                          <ChevronUp size={13} />
                        </IconButton>
                        <IconButton label={t("gateway.moveUpstreamDown")} variant="subtle" disabled={index === draft.upstreams.length - 1} onClick={() => moveUpstream(index, "down")}>
                          <ChevronDown size={13} />
                        </IconButton>
                      </div>
                      <div className="upstream-fields">
                      <input name={`upstreams.${index}.id`} value={upstream.id} onChange={(event) => updateUpstream(index, { id: event.target.value })} aria-label={t("gateway.ariaUpstreamId")} />
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
                      <StyledSelect
                        value={upstream.kind}
                        onValueChange={(next) => updateUpstream(index, { kind: next as GatewayUpstream["kind"] })}
                        options={[{ value: "secret", label: t("gateway.kindSecret") }, { value: "omp-auth-gateway", label: t("gateway.kindOmpAuth") }]}
                        ariaLabel={t("gateway.ariaAuthKind")}
                      />
                      <input
                        name={`upstreams.${index}.credentialId`}
                        value={upstream.credentialId ?? ""}
                        onChange={(event) => updateUpstream(index, { credentialId: event.target.value || undefined })}
                        className="upstream-credential"
                        placeholder={t("gateway.credentialId")}
                        aria-label={t("gateway.credentialId")}
                      />
                      </div>
                      <div className="upstream-actions">
                      <IconButton
                        className={probeResult?.ok ? "ok" : ""}
                        variant="subtle"
                        label={t("gateway.probeUpstream")}
                        onClick={() => void testProbe(upstream)}
                        disabled={loading || isProbing || !canProbe}
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
                        disabled={draft.upstreams.length <= 1}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="drawer-actions">
                <button className="primary-button" onClick={() => void saveDraft()} disabled={loading || readOnly || isProbing}>
                  <Save size={15} />{t("common.save")}
                </button>
                <button className="secondary-button" onClick={() => void start()} disabled={loading || readOnly || isProbing}>
                  <Play size={14} />{t(status.running && status.profileId !== profileId ? "gateway.switchProfile" : "gateway.start", { profile: profileId })}
                </button>
              </div>
              <p className="muted-line">{t("gateway.saveHint")}</p>
              {token && status.running && status.profileId === profileId ? (
                <label className="module-field">
                  <span>{t("gateway.bearerToken")}</span>
                  <input name="bearerToken" className="mono" readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
                </label>
              ) : null}
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
    </section>
  );
}
