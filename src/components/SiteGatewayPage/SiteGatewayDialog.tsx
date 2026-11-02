import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createSiteGateway, testSiteGateway, updateSiteGateway } from "../../api/client";
import type { SiteGatewaySummary, SiteGatewayTestResult } from "../../api/types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { Tag } from "../ui/Tag";
import { describeTestResult, gatewayUrlProblem } from "./siteGatewayFormat";
import "../../styles/dialogs.css";

interface SiteGatewayDialogProps {
  open: boolean;
  /** The gateway being edited; null adds a new one. */
  gateway: SiteGatewaySummary | null;
  onClose: () => void;
  /** Called after a successful save, before the dialog closes. */
  onSaved: () => void;
}

const FIELD = "w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-accent";

/** Add or edit a Site Gateway: name, address and the write-only ops token, with a Test connection button. */
export function SiteGatewayDialog({ open, gateway, onClose, onSaved }: SiteGatewayDialogProps) {
  const editing = gateway != null;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SiteGatewayTestResult | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose, busy == null);

  useEffect(() => {
    if (!open) return;
    setName(gateway?.name ?? "");
    setUrl(gateway?.url ?? "");
    setToken("");
    setClearToken(false);
    setBusy(null);
    setError(null);
    setResult(null);
    const t = window.setTimeout(() => urlRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gateway?.id]);

  useEffect(() => {
    if (!open || busy != null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, busy, onClose]);

  const urlProblem = gatewayUrlProblem(url);
  const urlTouched = url.trim() !== "";
  const typedToken = token.trim();
  // An edit that changes nothing is not worth a request.
  const changed = !editing || name.trim() !== gateway.name || url.trim() !== gateway.url || typedToken !== "" || clearToken;
  const canSave = urlProblem == null && busy == null && changed;
  const hasSavedToken = editing && gateway.tokenConfigured && !clearToken;

  const run = async (kind: "save" | "test") => {
    if (busy || urlProblem) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "test") {
        const body: { url: string; token?: string; id?: string } = { url: url.trim() };
        if (typedToken) body.token = typedToken;
        else if (editing && !clearToken) body.id = gateway.id;
        setResult(await testSiteGateway(body));
      } else {
        const input: { name?: string; url: string; token?: string } = { url: url.trim() };
        if (name.trim() || editing) input.name = name.trim() || undefined;
        if (typedToken) input.token = typedToken;
        else if (clearToken) input.token = "";
        if (editing) await updateSiteGateway(gateway.id, input);
        else await createSiteGateway(input);
        onSaved();
        onClose();
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  };

  if (!mounted) return null;
  const shown = result ? describeTestResult(result) : null;

  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div ref={trapRef} className="modal-sheet max-w-md" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header" id={titleId}>{editing ? "Edit Site Gateway" : "Add Site Gateway"}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void run("save");
          }}
        >
          <div className="modal-sheet__body space-y-3">
            <div>
              <label htmlFor={`${titleId}-name`} className="mb-1 block text-xs text-muted">Name</label>
              <input id={`${titleId}-name`} type="text" autoComplete="off" maxLength={64} value={name} disabled={busy != null}
                placeholder="Guomao" onChange={(e) => setName(e.target.value)} className={FIELD} />
            </div>
            <div>
              <label htmlFor={`${titleId}-url`} className="mb-1 block text-xs text-muted">URL</label>
              <input id={`${titleId}-url`} ref={urlRef} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={url}
                disabled={busy != null} placeholder="http://100.64.0.21:8200" aria-invalid={urlTouched && urlProblem != null}
                aria-describedby={`${titleId}-url-help`}
                onChange={(e) => { setUrl(e.target.value); setResult(null); }} className={FIELD} />
              <p id={`${titleId}-url-help`} className={`mt-1 text-[11px] ${urlTouched && urlProblem ? "text-danger" : "text-muted"}`}>
                {urlTouched && urlProblem ? urlProblem : "IP address and port of the Site Gateway, reachable from the dashboard server."}
              </p>
            </div>
            <div>
              <label htmlFor={`${titleId}-token`} className="mb-1 block text-xs text-muted">Ops key (optional)</label>
              <input id={`${titleId}-token`} type="password" autoComplete="new-password" spellCheck={false} value={token} disabled={busy != null}
                placeholder={hasSavedToken ? "Key saved — leave empty to keep it" : "SITE_GATEWAY_OPS_API_KEY"}
                onChange={(e) => { setToken(e.target.value); if (e.target.value) setClearToken(false); setResult(null); }} className={FIELD} />
              <p className="mt-1 text-[11px] text-muted">
                The gateway's read-only monitoring key. Without it only liveness is monitored. It is stored encrypted on the dashboard server and never shown again.
              </p>
              {editing && gateway.tokenConfigured ? (
                <label className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                  <input type="checkbox" checked={clearToken} disabled={busy != null || typedToken !== ""}
                    onChange={(e) => { setClearToken(e.target.checked); setResult(null); }} />
                  Remove the saved key
                </label>
              ) : null}
            </div>

            {shown ? (
              <div role="status" className="flex flex-wrap items-start gap-2 text-xs">
                <Tag tone={shown.tone}>{result?.ok ? "Reachable" : "Failed"}</Tag>
                <span className="min-w-0 flex-1 text-muted">{shown.text}</span>
              </div>
            ) : null}
            {error ? <div role="alert" className="rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div> : null}
          </div>

          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" onClick={() => void run("test")} disabled={urlProblem != null || busy != null}
                className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50">
                {busy === "test" ? "Testing…" : "Test connection"}
              </button>
              <button type="button" onClick={onClose} disabled={busy != null}
                className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={!canSave}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                {busy === "save" ? "Saving…" : editing ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
