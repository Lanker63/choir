import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { createTmpDirTerminationCleanup } from "../../utils/tmpCleanup.js";

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;

  exit(code?: number): never {
    this.exitCode = code ?? 0;
    this.emit("exit", this.exitCode);
    throw new Error("fake process exit");
  }
}

describe("tmp cleanup", () => {
  it("removes tracked .tmp-* directories when termination signal is emitted", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "choir-tmp-cleanup-test-"));
    const fakeProcess = new FakeProcess();
    const cleanup = createTmpDirTerminationCleanup({
      processLike: fakeProcess as unknown as NodeJS.Process,
      exitOnSignal: false,
    });

    try {
      cleanup.install();
      const trackedDir = cleanup.createTrackedTmpDir(path.join(parent, ".tmp-cleanup-tracked-"));
      const ignoredDir = cleanup.createTrackedTmpDir(path.join(parent, "not-tmp-cleanup-"));

      expect(fs.existsSync(trackedDir)).toBe(true);
      expect(fs.existsSync(ignoredDir)).toBe(true);

      fakeProcess.emit("SIGTERM");

      expect(fs.existsSync(trackedDir)).toBe(false);
      expect(fs.existsSync(ignoredDir)).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});