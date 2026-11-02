import { useState } from "react";
import { deleteSiteGateway } from "../../api/client";
import type { SiteGatewaySummary } from "../../api/types";
import { EditIcon, GlobeIcon, PlusIcon, XIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { SiteGatewayDialog } from "./SiteGatewayDialog";
import { UNKNOWN, fmtAgo, fmtCount, fmtLatency, fmtPercent, hostPort, summaryState } from "./siteGatewayFormat";
import { useSiteGatewayList } from "./useSiteGateway";
import "../../styles/sitegateway.css";

interface CardProps {
  gateway: SiteGatewaySummary;
  failed: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onChanged: () => void;
}

function GatewayCard({ gateway, failed, onOpen, onEdit, onChanged }: CardProps) {
  const state = summaryState(gateway, failed);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const windowMinutes = gateway.windowSeconds ? Math.max(1, Math.round(gateway.windowSeconds / 60)) : 5;
  const services = gateway.servicesReady != null && gateway.servicesTotal != null ? `${gateway.servicesReady}/${gateway.servicesTotal}` : UNKNOWN;
  const readOnly = gateway.source === "env";

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await deleteSiteGateway(gateway.id);
      onChanged();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
      setRemoving(false);
    }
  };

  return (
    <article className="panel sg-card" aria-label={gateway.name}>
      <button type="button" className="sg-card__open" onClick={onOpen} aria-label={`Open ${gateway.name}`}>
        <span className="sg-card__head">
          <span className="sg-card__name">{gateway.name}</span>
          <Tag tone={state.tone}>{state.text}</Tag>
        </span>
        <span className="sg-card__url font-tabular">{hostPort(gateway.url)}{readOnly ? " · from server environment" : ""}</span>
        <span className="sg-kpis">
          <span><span className="sg-kpi__label">Backends</span><span className="sg-kpi__value font-tabular">{services}</span></span>
          <span><span className="sg-kpi__label">In flight</span><span className="sg-kpi__value font-tabular">{fmtCount(gateway.inflightTotal)}</span></span>
          <span><span className="sg-kpi__label">Req / {windowMinutes} min</span><span className="sg-kpi__value font-tabular">{fmtCount(gateway.requests)}</span></span>
          <span>
            <span className="sg-kpi__label">5xx</span>
            <span className="sg-kpi__value font-tabular">{gateway.requests ? fmtPercent(gateway.errorRate) : UNKNOWN}</span>
          </span>
          <span><span className="sg-kpi__label">p95</span><span className="sg-kpi__value font-tabular">{fmtLatency(gateway.p95Ms)}</span></span>
        </span>
        <span className="sg-card__foot">Updated {fmtAgo(gateway.generatedAt)}</span>
      </button>
      {!readOnly ? (
        <div className="sg-card__actions">
          {confirming ? (
            <>
              <span className="sg-card__confirm">Remove?</span>
              <button type="button" className="btn btn--sm btn--danger" disabled={removing} onClick={() => void remove()}>
                {removing ? "Removing…" : "Remove"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" disabled={removing} onClick={() => { setConfirming(false); setRemoveError(null); }}>Keep</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--sm btn--ghost" title="Edit" aria-label={`Edit ${gateway.name}`} onClick={onEdit}><EditIcon className="h-3.5 w-3.5" /></button>
              <button type="button" className="btn btn--sm btn--ghost" title="Remove" aria-label={`Remove ${gateway.name}`} onClick={() => setConfirming(true)}><XIcon className="h-3.5 w-3.5" /></button>
            </>
          )}
        </div>
      ) : null}
      {removeError ? <p className="sg-card__error" role="alert">{removeError}</p> : null}
    </article>
  );
}

interface SiteGatewayListPageProps {
  /** Open one gateway's detail page. */
  onOpen: (gatewayId: string) => void;
}

/** Site Gateways home: one card per configured gateway, plus add / edit / remove. */
export function SiteGatewayListPage({ onOpen }: SiteGatewayListPageProps) {
  const { list, failed, reload } = useSiteGatewayList();
  const [dialog, setDialog] = useState<{ gateway: SiteGatewaySummary | null } | null>(null);
  const gateways = list?.gateways ?? [];

  return (
    <div className="sg">
      <header className="page-head">
        <div>
          <h1>Site Gateways</h1>
          <p className="page-head__sub">
            Every KarmaBox Site Gateway the dashboard watches. Open one for its backends, callers and trend. Counts are for the last few
            minutes and reset when a gateway restarts; — means unknown, not zero.
          </p>
        </div>
        <div className="page-head__tools">
          <button type="button" className="btn btn--sm" onClick={() => setDialog({ gateway: null })}>
            <PlusIcon className="h-3.5 w-3.5" />
            Add Site Gateway
          </button>
        </div>
      </header>

      {!list && !failed ? <div className="panel sg-state"><p>Loading Site Gateways…</p></div> : null}
      {failed ? <div className="panel sg-state" role="alert"><p>The dashboard server did not answer; Site Gateway state is unknown.</p></div> : null}

      {list && gateways.length === 0 ? (
        <div className="panel sg-state sg-empty-state">
          <GlobeIcon className="h-5 w-5" />
          <h3>No Site Gateway is monitored yet</h3>
          <p>
            Add the address of a KarmaBox Site Gateway (for example http://100.64.0.21:8200). With its read-only ops key you also see backends,
            request counts, errors and latency; without a key only liveness is checked.
          </p>
          <button type="button" className="btn btn--sm" onClick={() => setDialog({ gateway: null })}>Add Site Gateway</button>
        </div>
      ) : null}

      {gateways.length > 0 ? (
        <div className="sg-grid">
          {gateways.map((gateway) => (
            <GatewayCard
              key={gateway.id}
              gateway={gateway}
              failed={failed}
              onOpen={() => onOpen(gateway.id)}
              onEdit={() => setDialog({ gateway })}
              onChanged={reload}
            />
          ))}
        </div>
      ) : null}

      <SiteGatewayDialog
        open={dialog != null}
        gateway={dialog?.gateway ?? null}
        onClose={() => setDialog(null)}
        onSaved={reload}
      />
    </div>
  );
}
