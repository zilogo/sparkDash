import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSiteGateway, fetchSiteGateways } from "../../api/client";
import type { SiteGatewayDetail, SiteGatewayList } from "../../api/types";

const POLL_MS = 5000;
const NO_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Polls one JSON source on an interval. `failed` means the dashboard server did not answer
 * recently, which says nothing about any gateway. `reload` fetches right away (after an edit).
 */
function usePolled<T>(load: () => Promise<T>, key: string): { data: T | null; failed: boolean; error: Error | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let loading = false;
    let staleTimer: number | undefined;
    setData(null);
    setFailed(false);
    setError(null);
    const run = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await loadRef.current();
        if (!alive) return;
        setData(next);
        setFailed(false);
        setError(null);
        window.clearTimeout(staleTimer);
        staleTimer = window.setTimeout(() => {
          if (alive) setFailed(true);
        }, NO_RESPONSE_TIMEOUT_MS);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setFailed(true);
      } finally {
        loading = false;
      }
    };
    reloadRef.current = () => { void run(); };
    void run();
    const timer = window.setInterval(() => { void run(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); window.clearTimeout(staleTimer); };
  }, [key]);
  const reload = useCallback(() => reloadRef.current(), []);
  return { data, failed, error, reload };
}

/** The Site Gateways list (cards). */
export function useSiteGatewayList(): { list: SiteGatewayList | null; failed: boolean; reload: () => void } {
  const { data, failed, reload } = usePolled(fetchSiteGateways, "list");
  return { list: data, failed, reload };
}

/** One gateway's snapshot. `notFound` is true once the server says the gateway does not exist (any more). */
export function useSiteGatewayDetail(id: string): { snapshot: SiteGatewayDetail | null; failed: boolean; notFound: boolean; reload: () => void } {
  const { data, failed, error, reload } = usePolled(() => fetchSiteGateway(id), `detail:${id}`);
  return { snapshot: data, failed, notFound: error?.message === "Site Gateway not found", reload };
}
