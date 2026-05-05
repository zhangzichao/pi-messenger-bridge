/**
 * main-menu.ts — Interactive main menu for /msg-bridge.
 *
 * Shows transport status in the title, with Connect, Configure, Widget, and Help.
 */

import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { getDefaultWhatsAppAuthPath, loadConfig, loadFileConfig, saveConfig } from "../config.js";
import { acquireBotLocks, getConfiguredBotLockSpecs, releaseAllOwnedBotLocks, releaseBotLocks } from "../lock.js";
import { DiscordProvider } from "../transports/discord.js";
import type { ITransportProvider } from "../transports/interface.js";
import type { TransportManager } from "../transports/manager.js";
import { MatrixProvider } from "../transports/matrix.js";
import { SlackProvider } from "../transports/slack.js";
import { TelegramProvider } from "../transports/telegram.js";
import { WhatsAppProvider } from "../transports/whatsapp.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
};

export interface MenuContext {
  ui: MenuUI;
  transportManager: TransportManager;
  auth: ChallengeAuth;
  updateWidget: () => void;
  isBridgeAvailable: () => boolean;
  getUnavailableMessage: () => string;
}

// ── Status ──────────────────────────────────────────────────────────────────

function getStatusLine(mctx: MenuContext): string {
  const status = mctx.transportManager.getStatus();
  const stats = mctx.auth.getStats();

  if (status.length === 0) {
    return "No transports configured";
  }

  const transportLines = status
    .map((s) => `  ${s.connected ? "●" : "○"} ${s.type}`)
    .join("\n");

  return `${transportLines}\n  Trusted users: ${stats.trustedUsers}`;
}

function ensureBridgeAvailable(mctx: MenuContext): boolean {
  if (mctx.isBridgeAvailable()) return true;
  mctx.ui.notify(mctx.getUnavailableMessage(), "warning");
  return false;
}

// ── Help ────────────────────────────────────────────────────────────────────

function showHelp(mctx: MenuContext): void {
  mctx.ui.notify(
    "Subcommands:\n" +
    "  /msg-bridge status                — show connection status\n" +
    "  /msg-bridge connect               — connect all transports\n" +
    "  /msg-bridge disconnect            — disconnect all transports\n" +
    "  /msg-bridge configure <platform>  — set up a transport\n" +
    "  /msg-bridge widget                — toggle status widget",
    "info",
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function replaceConfiguredTransport(
  mctx: MenuContext,
  transport: ITransportProvider,
  previousConfig: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  try {
    const replaced = await mctx.transportManager.replaceTransport(transport);
    if (replaced) {
      releaseBotLocks(
        getConfiguredBotLockSpecs(previousConfig).filter((spec) => spec.transport === transport.type),
      );
    }
    return true;
  } catch (err) {
    mctx.ui.notify(
      `❌ Failed to disconnect existing ${transport.type} transport: ${(err as Error).message}`,
      "error",
    );
    return false;
  }
}

async function doConnect(mctx: MenuContext): Promise<void> {
  if (!ensureBridgeAvailable(mctx)) return;

  const lockResult = acquireBotLocks(getConfiguredBotLockSpecs(loadConfig()));
  if (!lockResult.ok) {
    mctx.ui.notify(`⚠️ ${lockResult.failed.label} is already connected in another pi session. Disconnect it there first.`, "warning");
    return;
  }

  try {
    await mctx.transportManager.connectAll();
    const cfg = loadFileConfig();
    cfg.autoConnect = true;
    saveConfig(cfg);
    mctx.ui.notify("✅ Connected to all configured transports", "info");
    mctx.updateWidget();
  } catch (err) {
    releaseBotLocks(lockResult.acquired);
    mctx.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
  }
}

async function doDisconnect(mctx: MenuContext): Promise<void> {
  if (!ensureBridgeAvailable(mctx)) return;

  await mctx.transportManager.disconnectAll();
  releaseAllOwnedBotLocks();
  const cfg = loadFileConfig();
  cfg.autoConnect = false;
  saveConfig(cfg);
  mctx.ui.notify("🔌 Disconnected from all transports", "info");
  mctx.updateWidget();
}

async function doConfigure(mctx: MenuContext): Promise<void> {
  if (!ensureBridgeAvailable(mctx)) return;

  const platform = await mctx.ui.select("Configure transport", [
    "Telegram",
    "WhatsApp",
    "Slack",
    "Discord",
    "Matrix",
  ]);
  if (!platform) return;

  const fileConfig = loadFileConfig();
  const effectiveConfig = loadConfig();

  switch (platform) {
    case "Telegram": {
      const token = await mctx.ui.input("Telegram bot token");
      if (!token) return;
      const provider = new TelegramProvider(token, mctx.auth);
      if (!(await replaceConfiguredTransport(mctx, provider, effectiveConfig))) {
        break;
      }
      fileConfig.telegram = { token };
      saveConfig(fileConfig);

      const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ telegram: { token } }));
      if (!lockResult.ok) {
        mctx.ui.notify("✅ Telegram configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
        break;
      }

      try {
        await provider.connect();
        mctx.ui.notify("✅ Telegram configured and connected", "info");
      } catch (_err) {
        releaseBotLocks(lockResult.acquired);
        mctx.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
      }
      break;
    }
    case "WhatsApp": {
      const authPath = await mctx.ui.input(`Auth path (enter for default: ${getDefaultWhatsAppAuthPath()}, esc to cancel)`);
      if (authPath === undefined) return; // cancelled

      const nextWhatsAppConfig = authPath ? { authPath } : {};
      const whatsappConfig = {
        ...nextWhatsAppConfig,
        authPath: nextWhatsAppConfig.authPath || getDefaultWhatsAppAuthPath(),
        debug: effectiveConfig.debug,
      };
      const provider = new WhatsAppProvider(whatsappConfig, mctx.auth);
      if (!(await replaceConfiguredTransport(mctx, provider, effectiveConfig))) {
        break;
      }
      fileConfig.whatsapp = nextWhatsAppConfig;
      saveConfig(fileConfig);

      const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ whatsapp: { authPath: whatsappConfig.authPath } }));
      if (!lockResult.ok) {
        mctx.ui.notify("✅ WhatsApp configured (that session is already connected in another pi session — run /msg-bridge connect later)", "info");
        break;
      }

      try {
        await provider.connect(true);
        mctx.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
      } catch (err) {
        releaseBotLocks(lockResult.acquired);
        mctx.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
      }
      break;
    }
    case "Slack": {
      const botToken = await mctx.ui.input("Slack bot token (xoxb-...)");
      if (!botToken) return;
      const appToken = await mctx.ui.input("Slack app token (xapp-...)");
      if (!appToken) return;

      const provider = new SlackProvider({ botToken, appToken }, mctx.auth);
      if (!(await replaceConfiguredTransport(mctx, provider, effectiveConfig))) {
        break;
      }
      fileConfig.slack = { botToken, appToken };
      saveConfig(fileConfig);

      const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ slack: { botToken, appToken } }));
      if (!lockResult.ok) {
        mctx.ui.notify("✅ Slack configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
        break;
      }

      try {
        await provider.connect();
        mctx.ui.notify("✅ Slack configured and connected", "info");
      } catch (err) {
        releaseBotLocks(lockResult.acquired);
        mctx.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
      }
      break;
    }
    case "Discord": {
      const token = await mctx.ui.input("Discord bot token");
      if (!token) return;
      const provider = new DiscordProvider({ token }, mctx.auth);
      if (!(await replaceConfiguredTransport(mctx, provider, effectiveConfig))) {
        break;
      }
      fileConfig.discord = { token };
      saveConfig(fileConfig);

      const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ discord: { token } }));
      if (!lockResult.ok) {
        mctx.ui.notify("✅ Discord configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
        break;
      }

      try {
        await provider.connect();
        mctx.ui.notify("✅ Discord configured and connected", "info");
      } catch (err) {
        releaseBotLocks(lockResult.acquired);
        mctx.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
      }
      break;
    }
    case "Matrix": {
      const homeserverUrl = await mctx.ui.input("Matrix homeserver URL (e.g. https://matrix.org)");
      if (!homeserverUrl) return;
      const accessToken = await mctx.ui.input("Matrix access token");
      if (!accessToken) return;
      config.matrix = { homeserverUrl, accessToken };
      saveConfig(config);
      const provider = new MatrixProvider(config.matrix, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect();
          mctx.ui.notify("✅ Matrix configured and connected", "info");
        } catch (err) {
          releaseLock();
          mctx.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
        }
      } else {
        mctx.ui.notify("✅ Matrix configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
  }
  mctx.updateWidget();
}

function doToggleWidget(mctx: MenuContext): void {
  if (!ensureBridgeAvailable(mctx)) return;

  const cfg = loadFileConfig();
  cfg.showWidget = cfg.showWidget === false;
  saveConfig(cfg);
  const state = cfg.showWidget !== false ? "shown" : "hidden";
  mctx.ui.notify(`📊 Status widget ${state}`, "info");
  mctx.updateWidget();
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  if (!ensureBridgeAvailable(mctx)) {
    return;
  }

  const mainMenu = async (): Promise<void> => {
    const statusLine = getStatusLine(mctx);
    const title = `Message Bridge\n${statusLine}`;

    const anyConnected = mctx.transportManager.getStatus().some((s) => s.connected);

    const choices = [
      anyConnected ? "Disconnect" : "Connect",
      "Configure",
      "Widget",
      "Help",
    ];

    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;

    switch (choice) {
      case "Connect":
        await doConnect(mctx);
        break;
      case "Disconnect":
        await doDisconnect(mctx);
        break;
      case "Configure":
        await doConfigure(mctx);
        break;
      case "Widget":
        doToggleWidget(mctx);
        break;
      case "Help":
        showHelp(mctx);
        break;
    }
    return mainMenu();
  };
  await mainMenu();
}
