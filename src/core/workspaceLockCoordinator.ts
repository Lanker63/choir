import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const LOCK_FILE_NAME = "workspace-mutation.lock";
const DEFAULT_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 25;
const DEFAULT_LEASE_MS = 120000;

type LockPayload = {
  schemaVersion: 1;
  owner: string;
  ownerToken: string;
  pid: number;
  host: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  leaseMs: number;
  expiresAtMs: number;
};

function lockDirectory(root: string): string {
  return path.join(root, ".choir", "locks");
}

function lockFilePath(root: string): string {
  return path.join(lockDirectory(root), LOCK_FILE_NAME);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildLockPayload(owner: string, ownerToken: string, leaseMs: number, nowMs: number): LockPayload {
  return {
    schemaVersion: 1,
    owner,
    ownerToken,
    pid: process.pid,
    host: os.hostname(),
    acquiredAtMs: nowMs,
    heartbeatAtMs: nowMs,
    leaseMs,
    expiresAtMs: nowMs + leaseMs,
  };
}

async function writeLockPayload(filePath: string, payload: LockPayload): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function readLockPayload(filePath: string): Promise<LockPayload | null> {
  try {
    const raw = (await fs.readFile(filePath, "utf-8")).trim();
    if (raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.owner !== "string"
      || typeof parsed.ownerToken !== "string"
      || typeof parsed.pid !== "number"
      || typeof parsed.host !== "string"
      || typeof parsed.acquiredAtMs !== "number"
      || typeof parsed.heartbeatAtMs !== "number"
      || typeof parsed.leaseMs !== "number"
      || typeof parsed.expiresAtMs !== "number"
    ) {
      return null;
    }

    return parsed as LockPayload;
  } catch {
    return null;
  }
}

async function tryCleanupStaleLock(filePath: string, nowMs: number): Promise<void> {
  try {
    const payload = await readLockPayload(filePath);
    if (!payload) {
      await fs.rm(filePath, { force: true });
      return;
    }

    if (payload.expiresAtMs <= nowMs) {
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
  options?: { timeoutMs?: number; leaseMs?: number; heartbeatMs?: number }
): Promise<T> {
  const filePath = lockFilePath(root);
  await fs.mkdir(lockDirectory(root), { recursive: true });

  const timeoutMs = Math.max(1000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const leaseMs = Math.max(1000, options?.leaseMs ?? DEFAULT_LEASE_MS);
  const heartbeatMs = Math.max(250, options?.heartbeatMs ?? Math.floor(leaseMs / 3));
  const ownerToken = randomUUID();
  const start = Date.now();
  let activeLock: LockPayload | null = null;

  while (true) {
    try {
      const handle = await fs.open(filePath, "wx");
      try {
        const nowMs = Date.now();
        const payload = buildLockPayload(owner, ownerToken, leaseMs, nowMs);
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf-8");
        activeLock = payload;
      } finally {
        await handle.close();
      }

      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      await tryCleanupStaleLock(filePath, Date.now());
      if ((Date.now() - start) > timeoutMs) {
        throw new Error(`Workspace mutation lock timeout after ${timeoutMs}ms: owner=${owner}`);
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (activeLock) {
    heartbeat = setInterval(() => {
      void (async () => {
        const current = await readLockPayload(filePath);
        if (!current || current.ownerToken !== activeLock?.ownerToken) {
          return;
        }

        const nowMs = Date.now();
        const next: LockPayload = {
          ...current,
          heartbeatAtMs: nowMs,
          expiresAtMs: nowMs + current.leaseMs,
        };
        await writeLockPayload(filePath, next);
      })();
    }, heartbeatMs);
  }

  try {
    return await work();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }

    const current = await readLockPayload(filePath);
    if (current?.ownerToken === ownerToken) {
      await fs.rm(filePath, { force: true });
    }
  }
}
