import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('lock', () => {
  let tmpHome: string;
  let workspaceA: string;
  let workspaceB: string;
  let originalCwd: string;
  const g = global as any;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpHome = mkdtempSync(join(tmpdir(), 'msg-bridge-home-'));
    workspaceA = mkdtempSync(join(tmpdir(), 'msg-bridge-workspace-a-'));
    workspaceB = mkdtempSync(join(tmpdir(), 'msg-bridge-workspace-b-'));
    delete g.__msgBridgeInstanceId;
    delete g.__msgBridgeWorkspaceLocks;
    delete g.__msgBridgeBotLocks;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete g.__msgBridgeInstanceId;
    delete g.__msgBridgeWorkspaceLocks;
    delete g.__msgBridgeBotLocks;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  });

  async function importLock(homeDir: string, workspaceDir: string) {
    process.chdir(workspaceDir);
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => homeDir };
    });
    return await import('../src/lock');
  }

  describe('workspace lock', () => {
    it('acquires workspace lock and writes a workspace-local session lock file', async () => {
      const { acquireWorkspaceLock, getWorkspaceLockPath, isWorkspaceLockOwnedByThisSession } = await importLock(tmpHome, workspaceA);

      expect(acquireWorkspaceLock()).toBe(true);
      expect(isWorkspaceLockOwnedByThisSession()).toBe(true);
      expect(getWorkspaceLockPath()).toBe(join(workspaceA, '.pi', 'msg-bridge', 'session.lock'));

      const content = readFileSync(getWorkspaceLockPath(), 'utf-8');
      const [pid, owner] = content.split(':');
      expect(parseInt(pid, 10)).toBe(process.pid);
      expect(owner).toBe(g.__msgBridgeInstanceId);
    });

    it('allows the same instance to re-acquire the workspace lock', async () => {
      const { acquireWorkspaceLock } = await importLock(tmpHome, workspaceA);
      expect(acquireWorkspaceLock()).toBe(true);
      expect(acquireWorkspaceLock()).toBe(true);
    });

    it('releases the workspace lock and removes the session lock file', async () => {
      const { acquireWorkspaceLock, getWorkspaceLockPath, releaseWorkspaceLock } = await importLock(tmpHome, workspaceA);
      acquireWorkspaceLock();

      releaseWorkspaceLock();
      expect(existsSync(getWorkspaceLockPath())).toBe(false);
    });

    it('blocks a different instance in the same workspace', async () => {
      const lock1 = await importLock(tmpHome, workspaceA);
      expect(lock1.acquireWorkspaceLock()).toBe(true);

      vi.resetModules();
      delete g.__msgBridgeInstanceId;
      const lock2 = await importLock(tmpHome, workspaceA);
      expect(lock2.acquireWorkspaceLock()).toBe(false);
    });

    it('allows different workspaces to hold independent workspace locks', async () => {
      const lock1 = await importLock(tmpHome, workspaceA);
      expect(lock1.acquireWorkspaceLock()).toBe(true);

      vi.resetModules();
      delete g.__msgBridgeInstanceId;
      const lock2 = await importLock(tmpHome, workspaceB);
      expect(lock2.acquireWorkspaceLock()).toBe(true);
    });

    it('overwrites a stale workspace lock from a dead process', async () => {
      const bridgeDir = join(workspaceA, '.pi', 'msg-bridge');
      mkdirSync(bridgeDir, { recursive: true });
      writeFileSync(join(bridgeDir, 'session.lock'), '1073741824:stale-owner');

      const { acquireWorkspaceLock } = await importLock(tmpHome, workspaceA);
      expect(acquireWorkspaceLock()).toBe(true);
    });

    it('blocks when a live process holds the workspace lock', async () => {
      const bridgeDir = join(workspaceA, '.pi', 'msg-bridge');
      mkdirSync(bridgeDir, { recursive: true });
      writeFileSync(join(bridgeDir, 'session.lock'), `${process.pid}:other-instance`);

      const { acquireWorkspaceLock } = await importLock(tmpHome, workspaceA);
      expect(acquireWorkspaceLock()).toBe(false);
    });
  });

  describe('bot lock', () => {
    it('acquires a bot lock and writes a global lock file', async () => {
      const { acquireBotLock, getBotLockPath } = await importLock(tmpHome, workspaceA);

      expect(acquireBotLock('slack-abc123')).toBe(true);
      const lockPath = getBotLockPath('slack-abc123');
      expect(lockPath).toBe(join(tmpHome, '.pi', 'msg-bridge', 'locks', 'slack-abc123.lock'));

      const content = readFileSync(lockPath, 'utf-8');
      const [pid, owner] = content.split(':');
      expect(parseInt(pid, 10)).toBe(process.pid);
      expect(owner).toBe(g.__msgBridgeInstanceId);
    });

    it('allows different bot keys simultaneously', async () => {
      const { acquireBotLock } = await importLock(tmpHome, workspaceA);
      expect(acquireBotLock('slack-bot-a')).toBe(true);
      expect(acquireBotLock('slack-bot-b')).toBe(true);
    });

    it('blocks the same bot key across instances', async () => {
      const lock1 = await importLock(tmpHome, workspaceA);
      expect(lock1.acquireBotLock('slack-shared')).toBe(true);

      vi.resetModules();
      delete g.__msgBridgeInstanceId;
      const lock2 = await importLock(tmpHome, workspaceB);
      expect(lock2.acquireBotLock('slack-shared')).toBe(false);
    });

    it('releases all bot locks owned by the current instance', async () => {
      const { acquireBotLock, getBotLockPath, releaseAllOwnedBotLocks } = await importLock(tmpHome, workspaceA);
      acquireBotLock('slack-a');
      acquireBotLock('discord-b');

      releaseAllOwnedBotLocks();
      expect(existsSync(getBotLockPath('slack-a'))).toBe(false);
      expect(existsSync(getBotLockPath('discord-b'))).toBe(false);
    });

    it('overwrites a stale bot lock from a dead process', async () => {
      const lockDir = join(tmpHome, '.pi', 'msg-bridge', 'locks');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'slack-stale.lock'), '1073741824:stale-owner');

      const { acquireBotLock } = await importLock(tmpHome, workspaceA);
      expect(acquireBotLock('slack-stale')).toBe(true);
    });

    it('blocks when a live process holds the same bot lock', async () => {
      const lockDir = join(tmpHome, '.pi', 'msg-bridge', 'locks');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'slack-live.lock'), `${process.pid}:other-instance`);

      const { acquireBotLock } = await importLock(tmpHome, workspaceA);
      expect(acquireBotLock('slack-live')).toBe(false);
    });

    it('derives stable lock specs without exposing raw secrets', async () => {
      const { getConfiguredBotLockSpecs } = await importLock(tmpHome, workspaceA);
      const specs1 = getConfiguredBotLockSpecs({ slack: { botToken: 'xoxb-a', appToken: 'xapp-a' } });
      const specs2 = getConfiguredBotLockSpecs({ slack: { botToken: 'xoxb-a', appToken: 'xapp-a' } });
      const specs3 = getConfiguredBotLockSpecs({ slack: { botToken: 'xoxb-b', appToken: 'xapp-b' } });

      expect(specs1[0]?.key).toBe(specs2[0]?.key);
      expect(specs1[0]?.key).not.toBe(specs3[0]?.key);
      expect(specs1[0]?.key.includes('xoxb-a')).toBe(false);
      expect(specs1[0]?.key.includes('xapp-a')).toBe(false);
      expect(specs1[0]?.label).toBe('Slack bot');
    });
  });
});
