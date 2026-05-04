import * as fs from "fs";
import * as path from "path";
import type { MsgBridgeConfig } from "./types.js";

const SESSION_ROOT = process.cwd();
const WORKSPACE_PI_DIR = path.join(SESSION_ROOT, ".pi");
const WORKSPACE_BRIDGE_DIR = path.join(WORKSPACE_PI_DIR, "msg-bridge");
const CONFIG_PATH = path.join(WORKSPACE_BRIDGE_DIR, "config.json");

function ensureBridgeDir(): void {
  if (!fs.existsSync(WORKSPACE_BRIDGE_DIR)) {
    fs.mkdirSync(WORKSPACE_BRIDGE_DIR, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(WORKSPACE_BRIDGE_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set msg-bridge directory permissions:", err);
  }
}

/**
 * Session workspace root (captured once when the extension module loads).
 */
export function getSessionRoot(): string {
  return SESSION_ROOT;
}

/**
 * Workspace-local msg-bridge directory.
 */
export function getWorkspaceBridgeDir(): string {
  return WORKSPACE_BRIDGE_DIR;
}

/**
 * Workspace-local msg-bridge config path.
 */
export function getWorkspaceConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Default workspace-local WhatsApp auth directory.
 */
export function getDefaultWhatsAppAuthPath(): string {
  return path.join(WORKSPACE_BRIDGE_DIR, "whatsapp-auth");
}

/**
 * Load persisted config from the workspace-local file only.
 */
export function loadFileConfig(): MsgBridgeConfig {
  const config: MsgBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  return config;
}

/**
 * Load effective config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const config = loadFileConfig();

  // Environment variables override file config (higher priority)
  if (process.env.PI_TELEGRAM_TOKEN) {
    config.telegram = { token: process.env.PI_TELEGRAM_TOKEN };
  }
  if (process.env.PI_WHATSAPP_AUTH_PATH) {
    config.whatsapp = { authPath: process.env.PI_WHATSAPP_AUTH_PATH };
  }
  if (process.env.PI_SLACK_BOT_TOKEN && process.env.PI_SLACK_APP_TOKEN) {
    config.slack = {
      botToken: process.env.PI_SLACK_BOT_TOKEN,
      appToken: process.env.PI_SLACK_APP_TOKEN,
    };
  }
  if (process.env.PI_DISCORD_TOKEN) {
    config.discord = { token: process.env.PI_DISCORD_TOKEN };
  }
  if (process.env.PI_MATRIX_HOMESERVER && process.env.PI_MATRIX_ACCESS_TOKEN) {
    config.matrix = {
      homeserverUrl: process.env.PI_MATRIX_HOMESERVER,
      accessToken: process.env.PI_MATRIX_ACCESS_TOKEN,
    };
  }

  return config;
}

/**
 * Save config to the workspace-local file with secure permissions.
 */
export function saveConfig(config: MsgBridgeConfig): void {
  ensureBridgeDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (err) {
    console.warn("Failed to set config file permissions:", err);
  }
}
