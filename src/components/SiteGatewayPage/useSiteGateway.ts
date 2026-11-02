import { useEffect, useState } from "react";
import { fetchSiteGateway } from "../../api/client";
import type { SiteGatewaySnapshot } from "../../api/types";

const POLL_MS = 5000;
const NO_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Polls the server's Site Gateway snapshot. `failed` means the dashboard server did not answer
 * recently, which says nothing about the gateway itself. Stops polling once the server reports
 * that monitoring is not configured.
 */
export function useSiteGateway(): { snapshot: SiteGatewaySnapshot | null; failed: boolean } {
  const [snapshot, setSnapshot] = useState<SiteGatewaySnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let loading = false;
    let disabled = false;
    let staleTimer: number | undefined;
    const load = async () => {
      if (loading || disabled) return;
      loading = true;
      try {
        const next = await fetchSiteGateway();
        if (!alive) return;
        disabled = next.enabled === false;
        setSnapshot(next);
        setFailed(false);
        window.clearTimeout(staleTimer);
        staleTimer = window.setTimeout(() => {
          if (alive) setFailed(true);
        }, NO_RESPONSE_TIMEOUT_MS);
      } catch {
        if (alive) setFailed(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); window.clearTimeout(staleTimer); };
  }, []);
  return { snapshot, failed };
}
