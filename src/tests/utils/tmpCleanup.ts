import fs from "fs";
import path from "path";

type ProcessEvents = Pick<NodeJS.Process, "once" | "exit">;
type FsModule = Pick<typeof fs, "mkdtempSync" | "rmSync">;

export type TmpDirTerminationCleanup = {
  install: () => void;
  trackTmpDir: (dir: string) => void;
  createTrackedTmpDir: (prefix: string) => string;
  cleanupNow: () => void;
};

export function createTmpDirTerminationCleanup(options: {
  fsModule?: FsModule;
  processLike?: ProcessEvents;
  exitOnSignal?: boolean;
} = {}): TmpDirTerminationCleanup {
  const fsModule = options.fsModule ?? fs;
  const processLike = options.processLike ?? process;
  const exitOnSignal = options.exitOnSignal ?? true;

  const trackedTmpDirs = new Set<string>();
  let installed = false;
  let cleanupInProgress = false;

  const cleanupNow = (): void => {
    if (cleanupInProgress) {
      return;
    }

    cleanupInProgress = true;
    try {
      const cleanupOrder = Array.from(trackedTmpDirs).sort((left, right) => right.length - left.length);
      for (const dir of cleanupOrder) {
        try {
          fsModule.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Cleanup is best-effort during termination; ignore file-system races.
        }
      }
      trackedTmpDirs.clear();
    } finally {
      cleanupInProgress = false;
    }
  };

  const trackTmpDir = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (path.basename(resolved).startsWith(".tmp-")) {
      trackedTmpDirs.add(resolved);
    }
  };

  const createTrackedTmpDir = (prefix: string): string => {
    const created = fsModule.mkdtempSync(prefix);
    trackTmpDir(created);
    return created;
  };

  const terminate = (exitCode: number): void => {
    cleanupNow();
    if (exitOnSignal) {
      processLike.exit(exitCode);
    }
  };

  const install = (): void => {
    if (installed) {
      return;
    }

    installed = true;
    processLike.once("beforeExit", cleanupNow);
    processLike.once("exit", cleanupNow);
    processLike.once("SIGINT", () => terminate(130));
    processLike.once("SIGTERM", () => terminate(143));
  };

  return {
    install,
    trackTmpDir,
    createTrackedTmpDir,
    cleanupNow,
  };
}

const defaultCleanup = createTmpDirTerminationCleanup();

export function installTmpDirTerminationCleanup(): void {
  defaultCleanup.install();
}

export function createTrackedTmpDir(prefix: string): string {
  return defaultCleanup.createTrackedTmpDir(prefix);
}

export function cleanupTrackedTmpDirs(): void {
  defaultCleanup.cleanupNow();
}
