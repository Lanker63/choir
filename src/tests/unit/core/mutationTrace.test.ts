import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPatch,
  recordMutationTrace,
  summarizeMutationTraces,
} from "../../../core/mutationTrace.js";
import type { Patch } from "../../../fix/types.js";

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

describe("mutationTrace", () => {
  it("classifies text and file patches by mechanism and safety", () => {
    const textPatch: Patch = {
      type: "replace",
      location: {
        file: "src/a.ts",
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      text: "b",
    };
    const createFilePatch: Patch = {
      type: "create-file",
      file: "src/generated.ts",
      content: "export {};\n",
    };
    const deleteFilePatch: Patch = {
      type: "delete-file",
      file: "src/old.ts",
    };

    expect(classifyPatch(textPatch)).toEqual(expect.objectContaining({
      mechanism: "text-patch",
      safety: "fragile",
      operation: "replace",
      targetFiles: ["src/a.ts"],
    }));
    expect(classifyPatch(createFilePatch)).toEqual(expect.objectContaining({
      mechanism: "file-patch",
      safety: "conditionally-safe",
      operation: "create-file",
    }));
    expect(classifyPatch(deleteFilePatch)).toEqual(expect.objectContaining({
      mechanism: "file-patch",
      safety: "dangerously-fragile",
      operation: "delete-file",
    }));
  });

  it("records stable JSONL mutation traces and summarizes them", () => {
    const root = makeTempRoot("choir-mutation-trace-");
    const first = recordMutationTrace(root, {
      source: "unit-test",
      mechanism: "yaml-structured",
      safety: "safe",
      operation: "write-yaml",
      targetFiles: [path.join(root, ".choir", "choir.config.yaml")],
      payload: { version: "1.0.0" },
    });
    const second = recordMutationTrace(root, {
      source: "unit-test",
      mechanism: "yaml-structured",
      safety: "safe",
      operation: "write-yaml",
      targetFiles: [path.join(root, ".choir", "choir.config.yaml")],
      payload: { version: "1.0.0" },
    });

    expect(second.id).toBe(first.id);
    expect(second.payloadHash).toBe(first.payloadHash);
    expect(fs.readFileSync(path.join(root, ".choir", "mutation-trace.jsonl"), "utf-8").trim().split("\n")).toHaveLength(2);
    expect(summarizeMutationTraces(root)).toEqual({
      total: 2,
      byMechanism: {
        "text-patch": 0,
        "file-patch": 0,
        "ts-morph": 0,
        "yaml-structured": 2,
        "state-structured": 0,
        "workspace-snapshot": 0,
      },
      bySafety: {
        safe: 2,
        "conditionally-safe": 0,
        fragile: 0,
        "dangerously-fragile": 0,
      },
    });
  });
});
