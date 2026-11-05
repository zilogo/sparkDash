/** Maximum stored length of a unit group name. */
export const MAX_GROUP_LENGTH = 64;

/**
 * Normalize an optional unit group name: trim, strip control characters,
 * cap the length. Anything empty or non-string means "ungrouped" (null).
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeGroup(value) {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, MAX_GROUP_LENGTH).trim();
  return clean || null;
}

/**
 * Validate the `group` field of a request body. Absent, null and strings are
 * accepted; any other type is rejected. Returns an error message or null.
 * @param {{ group?: unknown } | null | undefined} body
 */
export function validateGroupField(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "group")) return null;
  const g = body.group;
  if (g == null || typeof g === "string") return null;
  return "group must be a string or null";
}
