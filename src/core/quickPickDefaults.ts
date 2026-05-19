export type SingleSelectQuickPickItem<T extends string> = {
  label: T;
  picked?: boolean;
  description?: string;
};

export function withSingleSelectDefault<T extends string>(
  values: readonly T[],
  selected: T | undefined,
  marker = "current"
): SingleSelectQuickPickItem<T>[] {
  return values.map((value) => ({
    label: value,
    ...(selected === value
      ? {
        picked: true,
        description: marker,
      }
      : {}),
  }));
}