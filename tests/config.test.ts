import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('config', () => {
  let tmpWorkspace: string;
  let originalCwd: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpWorkspace = mkdtempSync(join(tmpdir(), 'msg-bridge-workspace-'));
    process.chdir(tmpWorkspace);
    delete process.env.PI_TELEGRAM_TOKEN;
    delete process.env.PI_WHATSAPP_AUTH_PATH;
    delete process.env.PI_SLACK_BOT_TOKEN;
    delete process.env.PI_SLACK_APP_TOKEN;
    delete process.env.PI_DISCORD_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  async function importConfig() {
    return await import('../src/config');
  }

  it('returns empty config when no file exists', async () => {
    const { loadConfig } = await importConfig();
    expect(loadConfig()).toEqual({});
  });

  it('saves and loads config roundtrip from the workspace-local file', async () => {
    const { getWorkspaceConfigPath, loadConfig, saveConfig } = await importConfig();

    saveConfig({ telegram: { token: 'test-token' }, autoConnect: true, debug: false });
    const loaded = loadConfig();

    expect(loaded.telegram?.token).toBe('test-token');
    expect(loaded.autoConnect).toBe(true);
    expect(loaded.debug).toBe(false);
    expect(getWorkspaceConfigPath()).toBe(join(tmpWorkspace, '.pi', 'msg-bridge', 'config.json'));
  });

  it('creates the workspace-local msg-bridge directory with 700 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpWorkspace, '.pi', 'msg-bridge'));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('writes the workspace-local config file with 600 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpWorkspace, '.pi', 'msg-bridge', 'config.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('env vars override file values for the same transport', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ telegram: { token: 'file-token' }, autoConnect: true });
    process.env.PI_TELEGRAM_TOKEN = 'env-token';

    const loaded = loadConfig();
    expect(loaded.telegram?.token).toBe('env-token');
    expect(loaded.autoConnect).toBe(true);
  });

  it('loads all transport env vars', async () => {
    process.env.PI_TELEGRAM_TOKEN = 'tg-token';
    process.env.PI_WHATSAPP_AUTH_PATH = '/wa/auth';
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-test';
    process.env.PI_DISCORD_TOKEN = 'dc-token';

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.telegram?.token).toBe('tg-token');
    expect(config.whatsapp?.authPath).toBe('/wa/auth');
    expect(config.slack?.botToken).toBe('xoxb-test');
    expect(config.slack?.appToken).toBe('xapp-test');
    expect(config.discord?.token).toBe('dc-token');
  });

  it('does not mix env-provided transport credentials into file-only config reads', async () => {
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-test';

    const { loadConfig, loadFileConfig, saveConfig } = await importConfig();
    saveConfig({ autoConnect: true });

    expect(loadFileConfig().slack).toBeUndefined();
    expect(loadFileConfig().autoConnect).toBe(true);
    expect(loadConfig().slack).toEqual({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  });

  it('handles corrupted config file gracefully', async () => {
    const bridgeDir = join(tmpWorkspace, '.pi', 'msg-bridge');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, 'config.json'), '{invalid json!!!');

    const { loadConfig } = await importConfig();
    expect(loadConfig()).toEqual({});
  });

  it('still applies env vars when config file is corrupted', async () => {
    const bridgeDir = join(tmpWorkspace, '.pi', 'msg-bridge');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, 'config.json'), 'not json');

    process.env.PI_TELEGRAM_TOKEN = 'env-token';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.telegram?.token).toBe('env-token');
  });

  it('requires both Slack tokens for slack config', async () => {
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';

    const { loadConfig } = await importConfig();
    expect(loadConfig().slack).toBeUndefined();
  });

  it('saves and loads hideToolCalls config', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ hideToolCalls: true, autoConnect: true });
    const loaded = loadConfig();

    expect(loaded.hideToolCalls).toBe(true);
    expect(loaded.autoConnect).toBe(true);
  });

  it('hideToolCalls defaults to undefined (not hidden)', async () => {
    const { loadConfig } = await importConfig();
    expect(loadConfig().hideToolCalls).toBeUndefined();
  });

  it('resolves the default WhatsApp auth path inside the workspace', async () => {
    const { getDefaultWhatsAppAuthPath } = await importConfig();
    expect(getDefaultWhatsAppAuthPath()).toBe(join(tmpWorkspace, '.pi', 'msg-bridge', 'whatsapp-auth'));
  });

  it('does not create config until saveConfig is called', async () => {
    const { getWorkspaceConfigPath, loadConfig } = await importConfig();
    expect(loadConfig()).toEqual({});
    expect(existsSync(getWorkspaceConfigPath())).toBe(false);
  });
});
