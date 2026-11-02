import "../../styles/sitegateway.css";
import type { SiteGatewaySummary } from "../../api/types";
import { useSiteGatewayDetail, useSiteGatewayList } from "../SiteGatewayPage/useSiteGateway";
import {
  UNKNOWN, SERVICE_TONE, fmtCount, fmtLatency, fmtPercent, gatewayHeadline, summaryState,
} from "../SiteGatewayPage/siteGatewayFormat";
import { GlobeIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

interface SiteGatewayCardProps {
  /** Open the Site Gateways list. */
  onOpenList?: () => void;
  /** Open one gateway's detail page. */
  onOpenGateway?: (gatewayId: string) => void;
}

/** One gateway, in full: the look the card had when there was a single gateway. */
function SingleGatewayCard({ gatewayId, onOpen }: { gatewayId: string; onOpen?: () => void }) {
  const { snapshot, failed } = useSiteGatewayDetail(gatewayId);
  const headline = gatewayHeadline(snapshot, failed);
  const status = !failed && snapshot?.available ? snapshot.status : null;
  const rows = status?.traffic.services ?? [];
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const requests = status ? sum((row) => row.requests) : null;
  const errors = status ? sum((row) => row.status5xx) : null;
  const p95 = rows.reduce<number | null>((max, row) => (row.latencyMs.p95 != null && (max == null || row.latencyMs.p95 > max) ? row.latencyMs.p95 : max), null);
  const windowMinutes = status ? Math.max(1, Math.round(status.windowSeconds / 60)) : 5;
  return (
    <Panel
      title="Site Gateway"
      icon={<GlobeIcon className="h-3.5 w-3.5" />}
      className="ov-card"
      bodyClassName="flex flex-col gap-3"
      actions={onOpen ? <button type="button" className="btn btn--sm btn--ghost" onClick={onOpen}>Details</button> : undefined}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate">{snapshot?.name ?? "KarmaBox gateway"}</span>
        <Tag tone={headline.tone}>{headline.text}</Tag>
      </div>
      {!snapshot && !failed ? <p className="text-[12px] text-muted">Waiting for Site Gateway status…</p> : null}
      {snapshot && snapshot.available && snapshot.mode === "liveness" ? (
        <p className="text-[12px] text-muted">
          Only the liveness check answers, so backends and request counts are unknown.
          {snapshot.tokenConfigured ? " The ops status endpoint did not respond." : " Add the gateway's ops key to see backends and traffic."}
        </p>
      ) : null}
      {status ? (
        <>
          <div className="sg-kpis">
            <div><span className="sg-kpi__label">In flight</span><span className="sg-kpi__value font-tabular">{fmtCount(status.traffic.inflightTotal)}</span></div>
            <div><span className="sg-kpi__label">Req / {windowMinutes} min</span><span className="sg-kpi__value font-tabular">{fmtCount(requests)}</span></div>
            <div><span className="sg-kpi__label">5xx</span><span className="sg-kpi__value font-tabular">{requests ? fmtPercent(errors! / requests) : UNKNOWN}</span></div>
            <div><span className="sg-kpi__label">p95</span><span className="sg-kpi__value font-tabular">{fmtLatency(p95)}</span></div>
          </div>
          <div className="sg-chips" aria-label="Backends">
            {status.services.map((service) => (
              <Tag key={service.id} tone={SERVICE_TONE[service.status]} title={`${service.id}: ${service.status}`}>
                {service.id}
              </Tag>
            ))}
          </div>
        </>
      ) : null}
      {snapshot && !snapshot.available && snapshot.reachable === false ? (
        <p className="text-[12px] text-muted">The gateway did not answer; traffic and backend state are unknown.</p>
      ) : null}
      {failed ? <p className="text-[12px] text-muted">The dashboard server did not answer; Site Gateway state is unknown.</p> : null}
    </Panel>
  );
}

function GatewayRow({ gateway, failed, onOpen }: { gateway: SiteGatewaySummary; failed: boolean; onOpen?: () => void }) {
  const state = summaryState(gateway, failed);
  return (
    <button type="button" className="sg-row" onClick={onOpen} aria-label={`${gateway.name}: ${state.text}`}>
      <span className={`sg-row__dot sg-row__dot--${state.tone}`} aria-hidden="true" />
      <span className="sg-row__name">{gateway.name}</span>
      <span className="sg-row__metric font-tabular" title="In flight">{fmtCount(gateway.inflightTotal)}<span className="sg-row__unit"> in flight</span></span>
      <span className="sg-row__metric font-tabular" title="5xx rate">{gateway.requests ? fmtPercent(gateway.errorRate) : UNKNOWN}<span className="sg-row__unit"> 5xx</span></span>
    </button>
  );
}

/**
 * Overview card for the Site Gateways: the full card for one gateway, a compact row per gateway for
 * several, and nothing when none is configured.
 */
export function SiteGatewayCard({ onOpenList, onOpenGateway }: SiteGatewayCardProps) {
  const { list, failed } = useSiteGatewayList();
  const gateways = list?.gateways ?? [];
  if (list && gateways.length === 0) return null;
  if (gateways.length === 1) {
    const only = gateways[0];
    return <SingleGatewayCard gatewayId={only.id} onOpen={onOpenGateway ? () => onOpenGateway(only.id) : onOpenList} />;
  }
  return (
    <Panel
      title="Site Gateways"
      icon={<GlobeIcon className="h-3.5 w-3.5" />}
      className="ov-card"
      bodyClassName="flex flex-col gap-2"
      actions={onOpenList ? <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenList}>All</button> : undefined}
    >
      {!list && !failed ? <p className="text-[12px] text-muted">Waiting for Site Gateway status…</p> : null}
      {failed ? <p className="text-[12px] text-muted">The dashboard server did not answer; Site Gateway state is unknown.</p> : null}
      {gateways.map((gateway) => (
        <GatewayRow key={gateway.id} gateway={gateway} failed={failed} onOpen={onOpenGateway ? () => onOpenGateway(gateway.id) : undefined} />
      ))}
    </Panel>
  );
}
