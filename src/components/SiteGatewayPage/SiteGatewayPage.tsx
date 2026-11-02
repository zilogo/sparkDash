import { useMemo } from "react";
import type { SiteGatewayPrincipal, SiteGatewayService, SiteGatewayTrafficService } from "../../api/types";
import { StackedBarChart, type BarSeries } from "../ui/StackedBarChart";
import { Tag } from "../ui/Tag";
import {
  SERVICE_TONE, UNKNOWN, fmtCount, fmtLatency, fmtPercent, fmtUptime, gatewayHeadline, trendBuckets,
} from "./siteGatewayFormat";
import { useSiteGateway } from "./useSiteGateway";
import "../../styles/sitegateway.css";

const SERIES: readonly BarSeries[] = [
  { id: "status5xx", label: "5xx", color: "var(--color-danger)" },
  { id: "rateLimited", label: "429", color: "var(--color-warning)" },
  { id: "other", label: "Other requests", color: "var(--color-success)" },
];

function ServiceTable({ services, traffic }: { services: SiteGatewayService[]; traffic: SiteGatewayTrafficService[] }) {
  const byId = new Map(traffic.map((row) => [row.service, row]));
  return (
    <table className="sg-table">
      <thead>
        <tr>
          <th>Backend</th><th>State</th><th>In flight</th><th>Requests</th><th>2xx</th><th>4xx</th><th>5xx</th>
          <th>429</th><th>Timeouts</th><th>5xx rate</th><th>p50</th><th>p95</th><th>Queue</th>
        </tr>
      </thead>
      <tbody>
        {services.map((service) => {
          const row = byId.get(service.id);
          return (
            <tr key={service.id}>
              <th scope="row">{service.id}<span className="sg-sub">{service.kind}</span></th>
              <td><Tag tone={SERVICE_TONE[service.status]}>{service.enabled ? service.status : "disabled"}</Tag></td>
              <td className="font-tabular">{fmtCount(row?.inflight)}</td>
              <td className="font-tabular">{fmtCount(row?.requests)}</td>
              <td className="font-tabular">{fmtCount(row?.status2xx)}</td>
              <td className="font-tabular">{fmtCount(row?.status4xx)}</td>
              <td className="font-tabular">{fmtCount(row?.status5xx)}</td>
              <td className="font-tabular">{fmtCount(row?.rateLimited)}</td>
              <td className="font-tabular">{fmtCount(row?.timeouts)}</td>
              <td className="font-tabular">{fmtPercent(row?.errorRate)}</td>
              <td className="font-tabular">{fmtLatency(row?.latencyMs.p50)}</td>
              <td className="font-tabular">{fmtLatency(row?.latencyMs.p95)}</td>
              <td className="font-tabular">{fmtCount(service.detail.queueDepth)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PrincipalTable({ principals }: { principals: SiteGatewayPrincipal[] }) {
  if (principals.length === 0) return <p className="sg-empty">No requests from any caller in this window.</p>;
  return (
    <table className="sg-table">
      <thead>
        <tr><th>Caller</th><th>Backend</th><th>In flight</th><th>Requests</th><th>4xx</th><th>5xx</th><th>429</th><th>Timeouts</th></tr>
      </thead>
      <tbody>
        {principals.map((row) => (
          <tr key={`${row.principal}/${row.service}`}>
            <th scope="row">{row.principal}</th>
            <td>{row.service}</td>
            <td className="font-tabular">{row.inflight}</td>
            <td className="font-tabular">{row.requests}</td>
            <td className="font-tabular">{row.status4xx}</td>
            <td className="font-tabular">{row.status5xx}</td>
            <td className="font-tabular">{row.rateLimited}</td>
            <td className="font-tabular">{row.timeouts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Site Gateway page: backend state, traffic per backend and per caller, per-minute trend. */
export function SiteGatewayPage() {
  const { snapshot, failed } = useSiteGateway();
  const headline = gatewayHeadline(snapshot, failed);
  const status = !failed && snapshot?.available ? snapshot.status : null;
  const buckets = useMemo(() => trendBuckets(failed ? null : snapshot), [snapshot, failed]);
  const windowMinutes = status ? Math.max(1, Math.round(status.windowSeconds / 60)) : 5;
  const chartTotal = buckets.reduce((sum, b) => sum + Object.values(b.values).reduce((a, v) => a + v, 0), 0);

  if (snapshot?.enabled === false) {
    return (
      <div className="sg">
        <header className="page-head"><div><h1>Site Gateway</h1></div></header>
        <div className="panel sg-state">
          <h3>Site Gateway monitoring is not configured</h3>
          <p>Set SPARKDASH_SITEGW_URL (and SPARKDASH_SITEGW_TOKEN for traffic and backend detail) in the server environment and restart sparkDash.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sg">
      <header className="page-head">
        <div>
          <h1>Site Gateway</h1>
          <p className="page-head__sub">
            Backend state and request traffic seen by the KarmaBox Site Gateway. Counts are for the last {windowMinutes} minutes and
            reset when the gateway restarts. Callers are shown by their configured key name, never by key.
          </p>
        </div>
        <div className="page-head__tools"><Tag tone={headline.tone}>{headline.text}</Tag></div>
      </header>

      {!snapshot && !failed ? <div className="panel sg-state"><p>Waiting for Site Gateway status…</p></div> : null}
      {failed ? <div className="panel sg-state" role="alert"><p>The dashboard server did not answer; Site Gateway state is unknown.</p></div> : null}
      {snapshot && !failed && !snapshot.available ? (
        <div className="panel sg-state">
          <h3>{snapshot.reachable === false ? "The gateway did not answer" : "Checking the gateway…"}</h3>
          <p>Backend state and traffic are unknown, not zero.</p>
        </div>
      ) : null}
      {snapshot && !failed && snapshot.available && snapshot.mode === "liveness" ? (
        <div className="panel sg-state">
          <h3>Liveness only</h3>
          <p>
            {snapshot.tokenConfigured
              ? "The gateway answers /healthz but its ops status endpoint did not respond (is it deployed, and is the ops key right?)."
              : "The gateway answers /healthz. Set SPARKDASH_SITEGW_TOKEN to the gateway's ops key to see backends and traffic."}{" "}
            Backend state and request counts are unknown.
          </p>
        </div>
      ) : null}

      {status ? (
        <>
          <div className="sg-tiles" role="group" aria-label="Summary">
            <div className="panel sg-tile"><span className="eyebrow">In flight</span><span className="big-num">{fmtCount(status.traffic.inflightTotal)}</span></div>
            <div className="panel sg-tile"><span className="eyebrow">Uptime</span><span className="big-num">{fmtUptime(status.uptimeSeconds)}</span></div>
            <div className="panel sg-tile">
              <span className="eyebrow">Per-caller limit</span>
              <span className="big-num">{fmtCount(status.limits.rateLimitPerMinute)}</span>
              <span className="sg-sub">req/min, {fmtCount(status.limits.maxConcurrentPerKey)} concurrent</span>
            </div>
            <div className="panel sg-tile"><span className="eyebrow">Site</span><span className="big-num sg-tile__text">{status.siteId}</span></div>
          </div>

          <section className="panel sg-section" aria-label="Backends">
            <h2 className="panel-title">Backends</h2>
            <div className="sg-scroll"><ServiceTable services={status.services} traffic={status.traffic.services} /></div>
          </section>

          <section className="panel sg-section" aria-label="Requests per minute">
            <div className="sg-section__head">
              <h2 className="panel-title">Requests per minute</h2>
              <ul className="sg-legend">
                {SERIES.map((s) => <li key={s.id}><i className={`sg-dot sg-dot--${s.id}`} aria-hidden="true" />{s.label}</li>)}
              </ul>
            </div>
            <StackedBarChart
              buckets={buckets}
              series={SERIES}
              height={150}
              format={(n) => String(Math.round(n))}
              unit="requests"
              empty="No requests in the gateway's history window."
              ariaLabel={`Requests per minute, ${chartTotal} in total`}
            />
          </section>

          <section className="panel sg-section" aria-label="Callers">
            <h2 className="panel-title">Callers</h2>
            <div className="sg-scroll"><PrincipalTable principals={status.traffic.principals} /></div>
          </section>
        </>
      ) : null}
      <p className="sg-foot">{UNKNOWN} means unknown, not zero. Latency percentiles are histogram bucket upper bounds.</p>
    </div>
  );
}
