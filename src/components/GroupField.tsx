import { useId } from "react";

interface GroupFieldProps {
  id: string;
  value: string | null | undefined;
  /** Existing group names offered as suggestions; typing a new name creates a group. */
  groups: readonly string[];
  onChange: (value: string | null) => void;
  /** Label class differs between the two dialogs. */
  labelClassName?: string;
}

/** Optional group input with a datalist of the groups that already exist. */
export function GroupField({ id, value, groups, onChange, labelClassName }: GroupFieldProps) {
  const listId = useId();
  return (
    <div className={labelClassName ? undefined : "field"}>
      <label htmlFor={id} className={labelClassName}>
        Group (optional)
      </label>
      <input
        id={id}
        type="text"
        value={value ?? ""}
        maxLength={64}
        list={listId}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="e.g. DeepSeek cluster"
        autoComplete="off"
      />
      <datalist id={listId}>
        {groups.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <p className="field-hint">A unit belongs to at most one group. Leave empty for none; type a new name to create a group.</p>
    </div>
  );
}
