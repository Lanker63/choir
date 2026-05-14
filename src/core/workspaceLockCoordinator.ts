import fs from "fs/promises";
import path from "path";

const LOCK_FILE_NAME = "workspace-mutation.lock";
const DEFAULT_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 25;
const STALE_LOCK_MS = 120000;

function lockDirectory(root: string): string {
  return path.join(root, ".choir", "locks");
}

function lockFilePath(root: string): string {
  return path.join(lockDirectory(root), LOCK_FILE_NAME);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function tryCleanupStaleLock(filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if ((Date.now() - stat.mtimeMs) > STALE_LOCK_MS) {
      await fs.rm(filePath, { force: true });
    }
  } catch {
    // Ignore races while checking stale lock files.
  }
}

export async function withWorkspaceMutationLock<T>(
  root: string,
  owner: string,
  work: () => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  const filePath = lockFilePath(root);
  await fs.mkdir(lockDirectory(root), { recursive: true });

  const timeoutMs = Math.max(1000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const start = Date.now();

  while (true) {
    try {
      const handle = await fs.open(filePath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ owner, acquiredAt: new Date().toISOString() }, null, 2),
          "utf-8"
        );
      } finally {
        await handle.close();
      }

      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      await tryCleanupStaleLock(filePath);
      if ((Date.now() - start) > timeoutMs) {
        throw new Error(`Workspace mutation lock timeout after ${timeoutMs}ms: owner=${owner}`);
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  try {
    return await work();
  } finally {
    await fs.rm(filePath, { force: true });
  }
}
