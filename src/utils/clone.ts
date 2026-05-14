export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneJsonOrUndefined<T>(value: T): T {
  if (typeof value === "undefined") {
    return value;
  }

  return cloneJson(value);
}
