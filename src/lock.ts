import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getDefaultWhatsAppAuthPath, getWorkspaceBridgeDir } from "./config.js";
import type { MsgBridgeConfig } from "./types.js";

/**
 * Workspace ownership lock.
 *
 * Prevents two pi sessions started in the same workspace from both mutating the
 * workspace-local msg-bridge state.
 */
const WORKSPACE_LOCK_PATH = path.join(getWorkspaceBridgeDir(), "session.lock");

/**
 * Global per-bot lock directory.
 *
 * Prevents the same bot/session identity from being connected by multiple pi
 * sessions at once, while still allowing different bots to connect elsewhere.
 */
const GLOBAL_LOCK_DIR = path.join(os.homedir(), ".pi", "msg-bridge", "locks");

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
if (!g.__msgBridgeWorkspaceLocks) {
  g.__msgBridgeWorkspaceLocks = new Map<string, string>();
}
if (!g.__msgBridgeBotLocks) {
  g.__msgBridgeBotLocks = new Map<string, string>();
}

const instanceId: string = g.__msgBridgeInstanceId;
const workspaceLocks: Map<string, string> = g.__msgBridgeWorkspaceLocks;
const botLocks: Map<string, string> = g.__msgBridgeBotLocks;

export interface BotLockSpec {
  transport: string;
  key: string;
  label: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // ignore permission fix failures
  }
}

function readLockFile(lockPath: string): { pid: number; owner: string } | null {
  if (!fs.existsSync(lockPath)) return null;

  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim().split(":");
    const pid = parseInt(raw[0] ?? "", 10);
    const owner = raw[1] ?? "";
    if (Number.isNaN(pid)) return null;
    return { pid, owner };
  } catch {
    return null;
  }
}

function acquireFileLock(lockPath: string, memoryMap: Map<string, string>, memoryKey: string, dirPath: string): boolean {
  const inMemoryOwner = memoryMap.get(memoryKey);
  if (inMemoryOwner && inMemoryOwner !== instanceId) {
    return false;
  }

  try {
    const existing = readLockFile(lockPath);
    if (existing) {
      if (existing.pid === process.pid && existing.owner !== instanceId) {
        return false;
      }

      if (existing.pid !== process.pid) {
        try {
          process.kill(existing.pid, 0);
          return false;
        } catch {
          // stale lock from a dead process — overwrite below
        }
      }
    }

    ensureDir(dirPath);
    fs.writeFileSync(lockPath, `${process.pid}:${instanceId}`, { mode: 0o600 });
    try {
      fs.chmodSync(lockPath, 0o600);
    } catch {
      // ignore
    }
  } catch {
    // lock file mechanics failed — rely on in-memory ownership below
  }

  memoryMap.set(memoryKey, instanceId);
  return true;
}

function releaseFileLock(lockPath: string, memoryMap: Map<string, string>, memoryKey: string): void {
  if (memoryMap.get(memoryKey) !== instanceId) return;

  memoryMap.delete(memoryKey);

  try {
    const existing = readLockFile(lockPath);
    if (existing && existing.pid === process.pid && existing.owner === instanceId) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

function hashFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function getWorkspaceLockPath(): string {
  return WORKSPACE_LOCK_PATH;
}

export function acquireWorkspaceLock(): boolean {
  return acquireFileLock(WORKSPACE_LOCK_PATH, workspaceLocks, WORKSPACE_LOCK_PATH, getWorkspaceBridgeDir());
}

export function releaseWorkspaceLock(): void {
  releaseFileLock(WORKSPACE_LOCK_PATH, workspaceLocks, WORKSPACE_LOCK_PATH);
}

export function isWorkspaceLockOwnedByThisSession(): boolean {
  return workspaceLocks.get(WORKSPACE_LOCK_PATH) === instanceId;
}

export function getBotLockPath(lockKey: string): string {
  return path.join(GLOBAL_LOCK_DIR, `${lockKey}.lock`);
}

export function acquireBotLock(lockKey: string): boolean {
  return acquireFileLock(getBotLockPath(lockKey), botLocks, lockKey, GLOBAL_LOCK_DIR);
}

export function releaseBotLock(lockKey: string): void {
  releaseFileLock(getBotLockPath(lockKey), botLocks, lockKey);
}

export function releaseAllOwnedBotLocks(): void {
  const ownedKeys = Array.from(botLocks.entries())
    .filter(([, owner]) => owner === instanceId)
    .map(([key]) => key);

  for (const key of ownedKeys) {
    releaseBotLock(key);
  }
}

export function getConfiguredBotLockSpecs(config: MsgBridgeConfig): BotLockSpec[] {
  const specs: BotLockSpec[] = [];

  if (config.telegram?.token) {
    specs.push({
      transport: "telegram",
      key: `telegram-${hashFingerprint(config.telegram.token)}`,
      label: "Telegram bot",
    });
  }

  if (config.whatsapp) {
    const authPath = path.resolve(config.whatsapp.authPath || getDefaultWhatsAppAuthPath());
    specs.push({
      transport: "whatsapp",
      key: `whatsapp-${hashFingerprint(authPath)}`,
      label: "WhatsApp session",
    });
  }

  if (config.slack?.botToken && config.slack?.appToken) {
    specs.push({
      transport: "slack",
      key: `slack-${hashFingerprint(`${config.slack.botToken}\n${config.slack.appToken}`)}`,
      label: "Slack bot",
    });
  }

  if (config.discord?.token) {
    specs.push({
      transport: "discord",
      key: `discord-${hashFingerprint(config.discord.token)}`,
      label: "Discord bot",
    });
  }

  return specs.sort((a, b) => a.key.localeCompare(b.key));
}

export function acquireBotLocks(specs: BotLockSpec[]): { ok: true; acquired: BotLockSpec[] } | { ok: false; failed: BotLockSpec; acquired: BotLockSpec[] } {
  const acquired: BotLockSpec[] = [];

  for (const spec of [...specs].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!acquireBotLock(spec.key)) {
      releaseBotLocks(acquired);
      return { ok: false, failed: spec, acquired };
    }
    acquired.push(spec);
  }

  return { ok: true, acquired };
}

export function releaseBotLocks(specs: BotLockSpec[]): void {
  for (const spec of [...specs].sort((a, b) => b.key.localeCompare(a.key))) {
    releaseBotLock(spec.key);
  }
}
