type ParameterizedEntry = {
  id: string;
  parameters?: Array<{ name: string }>;
};

export function sortByIdAndParameterName<T extends ParameterizedEntry>(entries: T[]): T[] {
  return [...entries]
    .map((entry) => ({
      ...entry,
      parameters: [...(entry.parameters ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    }) as T)
    .sort((left, right) => left.id.localeCompare(right.id));
}
