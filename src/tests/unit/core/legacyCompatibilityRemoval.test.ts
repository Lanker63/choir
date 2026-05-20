import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { installLibrary } from "../../../core/macroLibraries.js";
import { loadPersistedState } from "../../../core/persistentStateAudit.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy compatibility removal", () => {
  it("fails closed for legacy versioned library manifests", () => {
    const root = makeTempRoot("choir-legacy-library-");
    const legacyLibraryDir = path.join(root, ".choir", "libraries", "core", "1.0.0");
    fs.mkdirSync(legacyLibraryDir, { recursive: true });
    fs.writeFileSync(path.join(legacyLibraryDir, "macros.yaml"), [
      "name: core",
      "version: 1.0.0",
      "metadata:",
      "  description: legacy",
      "macros:",
      "  - id: enforce-service-boundaries",
      "    body:",
      "      - choir define goal \"legacy\"",
      "",
    ].join("\n"), "utf-8");

    expect(() => installLibrary(root, "core@1.0.0")).toThrow(/Library not found: core/);
  });

  it("does not migrate legacy state.json into recovery state", () => {
    const root = makeTempRoot("choir-legacy-state-");
    const choirRoot = path.join(root, ".choir");
    fs.mkdirSync(choirRoot, { recursive: true });
    fs.writeFileSync(path.join(choirRoot, "state.json"), JSON.stringify({
      version: "2.0.0",
      currentHash: "legacy-hash",
      logicalTime: 42,
    }, null, 2), "utf-8");

    const persisted = loadPersistedState(root);
    expect(persisted.currentHash).toBe("__UNINITIALIZED__");
    expect(persisted.logicalTime).toBe(0);
  });
});