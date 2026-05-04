export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }

  const maybeNode = value as Record<string, unknown>;
  if (
    typeof maybeNode.kind === "number" &&
    typeof maybeNode.pos === "number" &&
    typeof maybeNode.end === "number"
  ) {
    return value;
  }

  // Do not traverse host objects such as TS AST nodes and Maps.
  if (value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp) {
    return Object.freeze(value);
  }

  seen.add(value as object);

  const entries = Object.getOwnPropertyNames(value as object);
  for (const key of entries) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      deepFreeze(child, seen);
    }
  }

  return Object.freeze(value);
}
