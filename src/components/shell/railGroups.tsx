import { useCallback, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "../ui/icons";

const COLLAPSED_KEY = "sparkdash.sidebar.collapsedGroups";

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/** Collapsed group names, remembered in localStorage. */
export function useCollapsedGroups(): { isCollapsed: (name: string) => boolean; toggle: (name: string) => void } {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);
  return { isCollapsed: (name) => collapsed.includes(name), toggle };
}

interface RailGroupProps {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** The rows to show; the caller passes none (or only the active unit) while collapsed. */
  children: ReactNode;
}

/** A collapsible group header with its rows. */
export function RailGroup({ name, count, collapsed, onToggle, children }: RailGroupProps) {
  return (
    <div className="rail-group">
      <button type="button" className="rail-group__head" onClick={onToggle} aria-expanded={!collapsed}>
        <ChevronDownIcon className={`h-3 w-3 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        <span className="rail-group__name">{name}</span>
        <span className="rail-group__count">{count}</span>
      </button>
      {children}
    </div>
  );
}

/** Neutral heading for the units that belong to no group. */
export function RailUngroupedHeading() {
  return <div className="rail-group__head rail-group__head--static">Ungrouped</div>;
}
