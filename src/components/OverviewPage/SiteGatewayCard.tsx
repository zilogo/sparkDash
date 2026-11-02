import "../../styles/sitegateway.css";
import { useSiteGateway } from "../SiteGatewayPage/useSiteGateway";
import { UNKNOWN, SERVICE_TONE, fmtCount, fmtLatency, fmtPercent, gatewayHeadline } from "../SiteGatewayPage/siteGatewayFormat";
import { GlobeIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

interface SiteGatewayCardProps {
  onOpenDetails?: () => void;
}

/** Overview card for the optional Site Gateway; absent when the server has no gateway configured. */
export function SiteGatewayCard({ onOpenDetails }: SiteGatewayCardProps) {
  const { snapshot, failed } = useSiteGateway();
  if (snapshot?.enabled === false) return null;
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
      actions={onOpenDetails ? <button type="button" className="btn btn--sm btn--ghost" onClick={onOpenDetails}>Details</button> : undefined}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>KarmaBox gateway</span>
        <Tag tone={headline.tone}>{headline.text}</Tag>
      </div>
      {!snapshot && !failed ? <p className="text-[12px] text-muted">Waiting for Site Gateway status…</p> : null}
      {snapshot && snapshot.available && snapshot.mode === "liveness" ? (
        <p className="text-[12px] text-muted">
          Only the liveness check answers, so backends and request counts are unknown.
          {snapshot.tokenConfigured ? " The ops status endpoint did not respond." : " Set SPARKDASH_SITEGW_TOKEN to see backends and traffic."}
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
