import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ReactElement, Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, FileDiff, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { diffLines, patchMcpEntry, readMcpEntries, removeMcpEntry, trimContext } from "@omp-switch/shared";
import type { McpConfigFile, McpConfigPreview } from "@omp-switch/core";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/save-flow";
import { formatError } from "../../error-format";

export interface McpModuleApi {
  loadMcpConfig: (profileId: string) => Promise<McpConfigFile>;
  previewMcpConfig: (profileId: string, content: string, expectedHash: string | null) => Promise<McpConfigPreview>;
  saveMcpConfig: (profileId: string, content: string, expectedHash: string | null) => Promise<McpConfigFile>;
}

export interface McpModuleProps {
  api: McpModuleApi;
  profileId: string;
  readOnly: boolean;
  active?: boolean;
  editorRef?: Ref<McpEditorHandle>;
  onNotice?: (notice: { tone: "info" | "success" | "error"; text: string }) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface McpEditorHandle { save: () => void; refresh: () => void; }

interface EntryDraft {
  originalKey: string | null;
  key: string;
  objectJson: string;
  initialObjectJson: string;
}

export function McpModule({ api, profileId, readOnly, active = true, editorRef, onNotice, onDirtyChange }: McpModuleProps): ReactElement {
  const { t } = useTranslation();
  const [file, setFile] = useState<McpConfigFile | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<McpConfigPreview | null>(null);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [discard, setDiscard] = useState<"refresh" | "close" | null>(null);
  const generation = useRef(0);
  const source = useMemo(() => {
    if (file?.exists && !file.content.trim()) return { entries: [], error: t("mcp.invalidDocument") };
    try { return { entries: readMcpEntries(file?.content ?? ""), error: null }; }
    catch (cause) { return { entries: [], error: formatError(cause, t) }; }
  }, [file, t]);
  const dirty = Boolean(preview || (draft && (draft.originalKey === null || draft.key !== draft.originalKey || draft.objectJson !== draft.initialObjectJson)));
  const locked = busy || Boolean(preview) || readOnly || !active;
  const canMutate = !locked && Boolean(file && file.profileId === profileId) && !source.error;

  const translation = useRef(t);
  translation.current = t;
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const load = useCallback(async (id: string) => {
    const token = ++generation.current;
    setBusy(true); setError(null);
    try {
      const next = await api.loadMcpConfig(id);
      if (token !== generation.current) return;
      setFile(next); setDraft(null); setPreview(null); setDeleteKey(null); setDiscard(null);
    } catch (cause) {
      if (token === generation.current) setError(formatError(cause, translation.current));
    } finally { if (token === generation.current) setBusy(false); }
  }, [api]);

  useEffect(() => {
    setFile(null); setDraft(null); setPreview(null); setDeleteKey(null); setDiscard(null);
    void load(profileId);
    return () => { generation.current++; };
  }, [profileId, load]);

  const refresh = useCallback(() => {
    if (!active || busy || preview) return;
    if (dirty) setDiscard("refresh"); else void load(profileId);
  }, [active, busy, preview, dirty, load, profileId]);

  const startPreview = useCallback(async (removeKey?: string) => {
    if (!canMutate || !file || (removeKey === undefined && (!draft || !dirty))) return;
    const token = generation.current;
    setBusy(true); setError(null);
    try {
      const content = removeKey === undefined
        ? patchMcpEntry(file.content, draft!.originalKey, draft!.key, draft!.objectJson)
        : removeMcpEntry(file.content, removeKey);
      const next = await api.previewMcpConfig(profileId, content, file.hash);
      if (token === generation.current) { setPreview(next); setDeleteKey(null); }
    } catch (cause) {
      if (token === generation.current) { setError(formatError(cause, t)); setDeleteKey(null); }
    } finally { if (token === generation.current) setBusy(false); }
  }, [api, canMutate, file, draft, dirty, profileId, t]);

  const save = async () => {
    if (!active || !preview || preview.profileId !== profileId || !file || readOnly || busy) return;
    const token = generation.current;
    setBusy(true); setError(null);
    try {
      const saved = await api.saveMcpConfig(profileId, preview.content, preview.expectedHash);
      if (token !== generation.current) return;
      setFile(saved); setDraft(null); setPreview(null);
      onNotice?.({ tone: "success", text: t("mcp.saved") });
    } catch (cause) {
      if (token !== generation.current) return;
      const message = formatError(cause, t);
      setError(message); setPreview(null);
      onNotice?.({ tone: "error", text: message });
    } finally { if (token === generation.current) setBusy(false); }
  };

  useImperativeHandle(editorRef, () => ({ save: () => { if (active) void startPreview(); }, refresh }), [active, startPreview, refresh]);

  function openEntry(key: string | null, value: Record<string, unknown> = {}): void {
    if (!canMutate) return;
    const objectJson = JSON.stringify(value, null, 2);
    setError(null);
    setDraft({ originalKey: key, key: key ?? "", objectJson, initialObjectJson: objectJson });
  }
  function closeEditor(): void {
    if (busy || preview) return;
    if (dirty) setDiscard("close"); else { setDraft(null); setError(null); }
  }
  const diagnostics = [...(file?.diagnostics ?? []), ...(preview?.diagnostics ?? [])];
  return <>
    <div className="workspace-heading module-heading">
      <div><span className="eyebrow">{profileId}</span><h1>{t("mcp.heading")}<span className="heading-count">{source.entries.length}</span></h1></div>
      <div className="heading-actions">
        <button className="secondary-button" onClick={refresh} disabled={busy || Boolean(preview)}><RefreshCw size={15} />{t("common.refresh")}</button>
        <button className="primary-button" onClick={() => openEntry(null)} disabled={!canMutate}><Plus size={15} />{t("mcp.add")}</button>
      </div>
    </div>
    <section className="mcp-list-panel">
      <div className="mcp-file-bar"><span className="mono">{file?.path ?? t("common.loading")}</span>{file && !file.exists ? <span className="mcp-missing">{t("mcp.missing")}</span> : null}</div>
      {source.error || error ? <div className="inline-status error" role="alert"><AlertTriangle size={15} /><span>{source.error || error}</span></div> : null}
      {source.entries.length ? <div className="mcp-cards">{source.entries.map(({ key, value }) => {
        const transport = value.type === "stdio" || value.type === "sse" || value.type === "http" || value.type === "streamable-http" ? value.type : value.type === undefined ? (typeof value.url === "string" ? "http" : "stdio") : t("mcp.unknownTransport");
        return <article className="mcp-card" key={key}>
          <div className="mcp-card-main"><strong className="mono">{key}</strong><div className="mcp-card-meta"><span className="status-chip neutral">{transport}</span><span className={`status-chip ${value.enabled === false ? "neutral" : "ok"}`}>{t(value.enabled === false ? "mcp.disabled" : "mcp.configured")}</span></div></div>
          <div className="mcp-card-actions"><button className="secondary-button compact" onClick={() => openEntry(key, value)} disabled={!canMutate} aria-label={t("mcp.editEntry", { key })}><Pencil size={14} />{t("mcp.edit")}</button><button className="secondary-button compact danger" onClick={() => setDeleteKey(key)} disabled={!canMutate} aria-label={t("mcp.deleteEntry", { key })}><Trash2 size={14} />{t("common.delete")}</button></div>
        </article>;
      })}</div> : file && !source.error ? <div className="module-empty compact-empty"><strong>{t("mcp.empty")}</strong><span className="empty-desc">{t("mcp.emptyHint")}</span><button className="primary-button" onClick={() => openEntry(null)} disabled={!canMutate}><Plus size={15} />{t("mcp.add")}</button></div> : null}
      <div className="mcp-help"><span>{t("mcp.securityHint")}</span></div>
      {diagnostics.length ? <div className="mcp-diagnostics" role="status">{diagnostics.map((item, index) => <div className={`inline-status ${item.severity === "error" ? "error" : "warning"}`} key={`${item.code}-${index}`}><AlertTriangle size={14} /><span>{item.message}</span></div>)}</div> : null}
    </section>
    <Dialog.Root open={Boolean(draft) && !preview && active} onOpenChange={(open) => { if (!open) closeEditor(); }}>
      <Dialog.Portal><Dialog.Overlay className="dl-overlay" /><Dialog.Content className="dl-content mcp-entry-dialog" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void startPreview(); } }}>
        <div className="dl-head"><Dialog.Title asChild><h2>{t(draft?.originalKey === null ? "mcp.add" : "mcp.edit")}</h2></Dialog.Title></div>
        <Dialog.Description className="mcp-entry-description">{t("mcp.objectHint")}</Dialog.Description>
        <div className="dl-body mcp-entry-fields">
          {error ? <div className="inline-status error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div> : null}
          <label className="module-field"><span>{t("mcp.key")}</span><input name="mcpEntryKey" value={draft?.key ?? ""} disabled={locked} onChange={(event) => setDraft((current) => current && { ...current, key: event.target.value })} autoComplete="off" spellCheck={false} /></label>
          <label className="module-field"><span>{t("mcp.object")}</span><textarea name="mcpEntryObject" className="mcp-object-editor" value={draft?.objectJson ?? ""} disabled={locked} onChange={(event) => setDraft((current) => current && { ...current, objectJson: event.target.value })} spellCheck={false} /></label>
        </div>
        <div className="dl-actions"><button className="secondary-button" onClick={closeEditor} disabled={busy}>{t("common.cancel")}</button><button className="primary-button" onClick={() => void startPreview()} disabled={!canMutate || !dirty}><Save size={15} />{t("mcp.validateSave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={Boolean(preview) && active} onOpenChange={(open) => { if (!open && !busy) setPreview(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dl-overlay" /><Dialog.Content className="dl-content">
        <div className="dl-head"><div><span className="eyebrow">{t("mcp.review")}</span><Dialog.Title asChild><h2>{t("mcp.reviewTitle")}</h2></Dialog.Title></div></div>
        <Dialog.Description className="muted-line">{t("save.autoSnapshot")}</Dialog.Description>
        <div className="dl-body"><div className="dl-section"><div className="dl-section-title"><span className="mono">mcp.json</span></div><div className="diff-view">{preview ? trimContext(diffLines(preview.before, preview.content)).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="diff-marker">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span><span className="diff-text">{line.text || " "}</span></div>) : null}</div></div></div>
        <div className="dl-actions"><button className="secondary-button" onClick={() => setPreview(null)} disabled={busy}>{t("common.cancel")}</button><button className="primary-button" onClick={() => void save()} disabled={busy || readOnly}><FileDiff size={15} />{t("mcp.confirmSave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog open={deleteKey !== null && active} title={t("mcp.deleteEntry", { key: deleteKey })} message={t("mcp.deleteMessage")} confirmLabel={t("common.delete")} danger busy={locked} onClose={() => { if (!busy) setDeleteKey(null); }} onConfirm={() => { if (deleteKey !== null) void startPreview(deleteKey); }} />
    <ConfirmDialog open={discard !== null && active} title={t("mcp.discardTitle")} message={t("mcp.discardMessage")} confirmLabel={t("mcp.discardConfirm")} busy={busy} onClose={() => { if (!busy) setDiscard(null); }} onConfirm={() => { if (busy) return; const action = discard; setDiscard(null); if (action === "refresh") void load(profileId); else { setDraft(null); setError(null); } }} />
  </>;
}
