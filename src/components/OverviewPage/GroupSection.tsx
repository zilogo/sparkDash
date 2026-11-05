import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { formatMb } from "../../shared/formatBytes";
import { summarizeGroup } from "../../shared/sparkGroups";

const UNKNOWN = "—";

interface GroupSectionProps {
  /** Group name, or null for the units that have none. */
  name: string | null;
  /** Every unit of the group (not only the ones passing the search filter). */
  members: readonly SparkSnapshot[];
  /** The unit cards. */
  children: ReactNode;
}

/** One Overview section: heading, a summary row of group totals, then the unit cards. */
export function GroupSection({ name, members, children }: GroupSectionProps) {
  const sum = summarizeGroup(members);
  const memory = sum.memUsedMb != null && sum.memTotalMb != null ? `${formatMb(sum.memUsedMb)} / ${formatMb(sum.memTotalMb)}` : UNKNOWN;
  const title = name ?? "Ungrouped";
  return (
    <section className="ov-group" aria-label={`Group ${title}`}>
      <div className="ov-group__head">
        <h2 className="ov-group__title">{title}</h2>
        <dl className="ov-group__summary">
          <div>
            <dt>Online</dt>
            <dd>
              {sum.online}/{sum.total}
            </dd>
          </div>
          <div>
            <dt>GPU memory</dt>
            <dd>{memory}</dd>
          </div>
          <div>
            <dt>LLM endpoints serving</dt>
            <dd>{sum.llmServing ?? UNKNOWN}</dd>
          </div>
        </dl>
      </div>
      {children}
    </section>
  );
}
