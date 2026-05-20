import { deterministicHash } from "./deterministicCore.js";
import type { Patch } from "../fix/types.js";
import type { SemanticMutationManifest } from "./semanticMutation.js";

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function projectSemanticManifestToPatches(manifest: SemanticMutationManifest): Patch[] {
  const byFile = new Map(manifest.fileDeltas.map((delta) => [delta.file, delta] as const));

  return sortedUnique(manifest.fileDeltas.map((delta) => delta.file)).map((file) => {
    const delta = byFile.get(file);
    if (!delta) {
      throw new Error(`Missing file delta for ${file}`);
    }

    if (delta.operation === "delete") {
      return {
        type: "delete-file",
        file,
      } satisfies Patch;
    }

    // Semantic mutation manifests are compiler-authoritative; patch projection is for replay compatibility only.
    return {
      type: "create-file",
      file,
      content: `// semantic-manifest:${manifest.id}\n// hash:${deterministicHash(delta)}\n`,
    } satisfies Patch;
  });
}
