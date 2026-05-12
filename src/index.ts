import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { getDefaultWhatsAppAuthPath, loadConfig, loadFileConfig, saveConfig } from "./config.js";
import { extractTextFromMessage, formatToolCalls, hasToolCalls, splitMessage } from "./formatting.js";
import {
  acquireBotLocks,
  acquireWorkspaceLock,
  getConfiguredBotLockSpecs,
  getWorkspaceLockPath,
  releaseAllOwnedBotLocks,
  releaseBotLocks,
  releaseWorkspaceLock,
} from "./lock.js";
import { DiscordProvider } from "./transports/discord.js";
import type { ITransportProvider } from "./transports/interface.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import type { MsgBridgeConfig, PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;
  let workspaceAvailable = false;

  function getWorkspaceUnavailableMessage(): string {
    return `ℹ️ msg-bridge is disabled in this session because another pi instance already owns this workspace (${getWorkspaceLockPath()}).`;
  }

  function notifyBotLockConflict(lockLabel: string, ui: ExtensionContext["ui"] | { notify(message: string, type: "info" | "warning" | "error"): void }): void {
    ui.notify(`⚠️ ${lockLabel} is already connected in another pi session. Disconnect it there first.`, "warning");
  }

  function ensureWorkspaceAvailable(ui: ExtensionContext["ui"] | { notify(message: string, type: "info" | "warning" | "error"): void }): boolean {
    if (workspaceAvailable) {
      return true;
    }
    ui.notify(getWorkspaceUnavailableMessage(), "warning");
    return false;
  }

  /**
   * Update status widget
   */
  function updateWidget(): void {
    if (!ctx || !workspaceAvailable) {
      ctx?.ui.setWidget("msg-bridge-status", undefined);
      return;
    }

    const config = loadFileConfig();

    if (config.showWidget === false) {
      ctx.ui.setWidget("msg-bridge-status", undefined);
      return;
    }

    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("msg-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("msg-bridge-status", undefined);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    if (!workspaceAvailable) return;

    const config = loadFileConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  async function replaceConfiguredTransport(
    transport: ITransportProvider,
    previousConfig: MsgBridgeConfig,
    ui: ExtensionContext["ui"],
  ): Promise<boolean> {
    try {
      const replaced = await transportManager.replaceTransport(transport);
      if (replaced) {
        releaseBotLocks(
          getConfiguredBotLockSpecs(previousConfig).filter((spec) => spec.transport === transport.type),
        );
      }
      return true;
    } catch (err) {
      ui.notify(
        `❌ Failed to disconnect existing ${transport.type} transport: ${(err as Error).message}`,
        "error",
      );
      return false;
    }
  }

  async function connectConfiguredTransports(ui: ExtensionContext["ui"]): Promise<boolean> {
    if (!ensureWorkspaceAvailable(ui)) {
      return false;
    }

    const lockResult = acquireBotLocks(getConfiguredBotLockSpecs(loadConfig()));
    if (!lockResult.ok) {
      notifyBotLockConflict(lockResult.failed.label, ui);
      return false;
    }

    try {
      await transportManager.connectAll();
      const fileConfig = loadFileConfig();
      fileConfig.autoConnect = true;
      saveConfig(fileConfig);
      ui.notify("✅ Connected to all configured transports", "info");
      updateWidget();
      return true;
    } catch (err) {
      releaseBotLocks(lockResult.acquired);
      ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
      return false;
    }
  }

  async function disconnectConfiguredTransports(ui: ExtensionContext["ui"]): Promise<void> {
    if (!ensureWorkspaceAvailable(ui)) {
      return;
    }

    await transportManager.disconnectAll();
    releaseAllOwnedBotLocks();
    const fileConfig = loadFileConfig();
    fileConfig.autoConnect = false;
    saveConfig(fileConfig);
    ui.notify("🔌 Disconnected from all transports", "info");
    updateWidget();
  }

  function maybeClearMissingWhatsAppConfig(fileConfig: MsgBridgeConfig): void {
    if (process.env.PI_WHATSAPP_AUTH_PATH || !fileConfig.whatsapp) {
      return;
    }

    const authPath = fileConfig.whatsapp.authPath || getDefaultWhatsAppAuthPath();
    const credsPath = path.join(authPath, "creds.json");
    if (fs.existsSync(credsPath)) {
      return;
    }

    delete fileConfig.whatsapp;
    saveConfig(fileConfig);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    workspaceAvailable = acquireWorkspaceLock();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState
    );

    if (!workspaceAvailable) {
      ctx.ui.notify(getWorkspaceUnavailableMessage(), "info");
      updateWidget();
      return;
    }

    const fileConfig = loadFileConfig();
    maybeClearMissingWhatsAppConfig(fileConfig);
    const config = loadConfig();

    if (fileConfig.auth) {
      auth.loadFromConfig(fileConfig.auth);
    }

    // Initialize transports in the background (non-blocking)
    (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      if (config.whatsapp) {
        const whatsappAuthPath = config.whatsapp.authPath || getDefaultWhatsAppAuthPath();
        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = {
                ...config.whatsapp!,
                authPath: whatsappAuthPath,
                debug: config.debug,
              };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              transportManager.addTransport(whatsappProvider);
            })
          );
        }
      }

      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth, {
              notify: (message, type) => ctx.ui.notify(message, type),
            });
            transportManager.addTransport(slackProvider);
          })
        );
      }

      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const discordProvider = new DiscordProvider(config.discord!, auth);
            transportManager.addTransport(discordProvider);
          })
        );
      }

      if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const matrixProvider = new MatrixProvider(config.matrix!, auth);
            transportManager.addTransport(matrixProvider);
          })
        );
      }

      await Promise.all(transportPromises);

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && fileConfig.autoConnect !== false) {
        const lockResult = acquireBotLocks(getConfiguredBotLockSpecs(config));
        if (!lockResult.ok) {
          notifyBotLockConflict(lockResult.failed.label, ctx.ui);
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseBotLocks(lockResult.acquired);
            ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      console.error("Transport initialization error:", err);
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage((msg) => {
      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
      };

      // Persist last known chat target per transport for proactive messaging
      if (workspaceAvailable && msg.transport && msg.chatId) {
        const cfg = loadFileConfig();
        if (!cfg.lastChatTargets) cfg.lastChatTargets = {};
        cfg.lastChatTargets[msg.transport] = {
          chatId: msg.chatId,
          username: msg.username,
        };
        saveConfig(cfg);
      }

      const marker = !msg.isGroupChat ? "D" : msg.wasMentioned ? "C-M" : "C";
      const chatLabel = msg.isGroupChat
        ? msg.chatName
          ? `${msg.chatName}, id=${msg.chatId}`
          : `id=${msg.chatId}`
        : undefined;
      const taggedMessage = chatLabel
        ? `📱 [${marker}] @${msg.username} via ${msg.transport} (${chatLabel}): ${msg.content}`
        : `📱 [${marker}] @${msg.username} via ${msg.transport}: ${msg.content}`;
      pi.sendUserMessage(taggedMessage, { deliverAs: "followUp" });
    });

    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    updateWidget();
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport
        );
      } catch (_err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat) return;

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const hasPendingTools = hasToolCalls(message);
      const config = loadConfig();

      const parts: string[] = [];
      const trimmedResponse = responseText.trim();
      if (trimmedResponse) parts.push(trimmedResponse);
      if (toolCallsText && !config.hideToolCalls) parts.push(toolCallsText);

      if (parts.length === 0) {
        // Nothing to send this turn — don't touch pendingRemoteChat;
        // a future turn_end may have the actual response text.
        return;
      }

      const fullText = parts.join("\n\n");

      // Split long messages for Telegram's 4096 char limit
      const chunks = splitMessage(fullText, 4000);
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          chunk
        );
      }

      if (!hasPendingTools) {
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      pendingRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release locks and disconnect transports
   */
  pi.on("session_shutdown", async (_event, _context) => {
    await transportManager.disconnectAll();
    releaseAllOwnedBotLocks();
    releaseWorkspaceLock();
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

      // No subcommand → open interactive menu
      if (!subcommand || subcommand === "menu") {
        await openMainMenu({
          ui: context.ui,
          transportManager,
          auth,
          updateWidget,
          isBridgeAvailable: () => workspaceAvailable,
          getUnavailableMessage: getWorkspaceUnavailableMessage,
        });
        return;
      }

      switch (subcommand) {
        case "help": {
          const helpText = [
            "━━━ Message Bridge Commands ━━━",
            "",
            "/msg-bridge                   Open interactive menu",
            "/msg-bridge help              Show this help",
            "/msg-bridge status            Show connection and user status",
            "/msg-bridge connect           Connect to all transports",
            "/msg-bridge disconnect        Disconnect from all transports",
            "/msg-bridge configure telegram <token>",
            "                              Configure Telegram bot",
            "/msg-bridge configure whatsapp",
            "                              Configure WhatsApp (scan QR)",
            "/msg-bridge widget            Toggle status widget on/off",
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          ];
          context.ui.notify(helpText.join("\n"), "info");
          break;
        }
        case "connect":
          await connectConfiguredTransports(context.ui);
          break;

        case "disconnect": {
          await disconnectConfiguredTransports(context.ui);
          break;
        }

        case "configure": {
          if (!ensureWorkspaceAvailable(context.ui)) {
            return;
          }

          const platform = parts[1];
          const token = parts.slice(2).join(" ");

          if (!platform) {
            context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
            return;
          }

          const fileConfig = loadFileConfig();
          const effectiveConfig = loadConfig();

          switch (platform.toLowerCase()) {
            case "telegram": {
              if (!token) {
                context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
                return;
              }
              const telegramProvider = new TelegramProvider(token, auth);
              if (!(await replaceConfiguredTransport(telegramProvider, effectiveConfig, context.ui))) {
                break;
              }
              fileConfig.telegram = { token };
              saveConfig(fileConfig);
              const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ telegram: { token } }));
              if (!lockResult.ok) {
                context.ui.notify("✅ Telegram configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
                break;
              }
              try {
                await telegramProvider.connect();
                context.ui.notify("✅ Telegram configured and connected", "info");
              } catch (_err) {
                releaseBotLocks(lockResult.acquired);
                context.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
              }
              updateWidget();
              break;
            }

            case "whatsapp": {
              const nextWhatsAppConfig = token ? { authPath: token } : {};
              const whatsappAuthPath = nextWhatsAppConfig.authPath || getDefaultWhatsAppAuthPath();
              const whatsappConfig = {
                ...nextWhatsAppConfig,
                authPath: whatsappAuthPath,
                debug: effectiveConfig.debug,
              };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              if (!(await replaceConfiguredTransport(whatsappProvider, effectiveConfig, context.ui))) {
                break;
              }
              fileConfig.whatsapp = nextWhatsAppConfig;
              saveConfig(fileConfig);
              const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ whatsapp: { authPath: whatsappAuthPath } }));
              if (!lockResult.ok) {
                context.ui.notify("✅ WhatsApp configured (that session is already connected in another pi session — run /msg-bridge connect later)", "info");
                break;
              }
              try {
                await whatsappProvider.connect(true);
                context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
              } catch (err) {
                releaseBotLocks(lockResult.acquired);
                context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
              }
              updateWidget();
              break;
            }

            case "slack": {
              const parts2 = token.split(/\s+/);
              const botToken = parts2[0];
              const appToken = parts2[1];

              if (!botToken || !appToken) {
                context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
                return;
              }

              const slackProvider = new SlackProvider({ botToken, appToken }, auth, {
                notify: (message, type) => context.ui.notify(message, type),
              });
              if (!(await replaceConfiguredTransport(slackProvider, effectiveConfig, context.ui))) {
                break;
              }
              fileConfig.slack = { botToken, appToken };
              saveConfig(fileConfig);
              const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ slack: { botToken, appToken } }));
              if (!lockResult.ok) {
                context.ui.notify("✅ Slack configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
                break;
              }
              try {
                await slackProvider.connect();
                context.ui.notify("✅ Slack configured and connected", "info");
              } catch (err) {
                releaseBotLocks(lockResult.acquired);
                context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
              }
              updateWidget();
              break;
            }

            case "discord": {
              if (!token) {
                context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
                return;
              }

              const discordProvider = new DiscordProvider({ token }, auth);
              if (!(await replaceConfiguredTransport(discordProvider, effectiveConfig, context.ui))) {
                break;
              }
              fileConfig.discord = { token };
              saveConfig(fileConfig);
              const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ discord: { token } }));
              if (!lockResult.ok) {
                context.ui.notify("✅ Discord configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
                break;
              }
              try {
                await discordProvider.connect();
                context.ui.notify("✅ Discord configured and connected", "info");
              } catch (err) {
                releaseBotLocks(lockResult.acquired);
                context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
              }
              updateWidget();
              break;
            }

            case "matrix": {
              const matrixParts = token.split(/\s+/);
              const homeserverUrl = matrixParts[0];
              const matrixAccessToken = matrixParts.slice(1).join(" ");
              if (!homeserverUrl || !matrixAccessToken) {
                context.ui.notify("Usage: /msg-bridge configure matrix <homeserver-url> <access-token>", "error");
                return;
              }

              fileConfig.matrix = { homeserverUrl, accessToken: matrixAccessToken };
              saveConfig(fileConfig);
              const matrixProvider = new MatrixProvider(fileConfig.matrix, auth);
              transportManager.addTransport(matrixProvider);
              const lockResult = acquireBotLocks(getConfiguredBotLockSpecs({ matrix: { homeserverUrl, accessToken: matrixAccessToken } }));
              if (!lockResult.ok) {
                context.ui.notify("✅ Matrix configured (that bot is already connected in another pi session — run /msg-bridge connect later)", "info");
                break;
              }
              try {
                await matrixProvider.connect();
                context.ui.notify("✅ Matrix configured and connected", "info");
              } catch (err) {
                releaseBotLocks(lockResult.acquired);
                context.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
              }
              updateWidget();
              break;
            }

            default:
              context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
          }
          break;
        }

        case "widget": {
          if (!ensureWorkspaceAvailable(context.ui)) {
            return;
          }

          const cfg = loadFileConfig();
          cfg.showWidget = cfg.showWidget === false;
          saveConfig(cfg);
          const widgetState = cfg.showWidget !== false ? "shown" : "hidden";
          context.ui.notify(`📊 Status widget ${widgetState}`, "info");
          updateWidget();
          break;
        }

        case "status": {
          if (!workspaceAvailable) {
            context.ui.notify(getWorkspaceUnavailableMessage(), "info");
            break;
          }

          const stats = auth.getStats();
          const status = transportManager.getStatus();
          const lines = [
            "━━━ Message Bridge Status ━━━",
            "",
            "Transports:",
            ...status.map(
              (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
            ),
            "",
            `Trusted Users: ${stats.trustedUsers}`,
          ];

          if (stats.trustedUsers > 0) {
            for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
              if (userIds.length > 0) {
                lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
              }
            }
          }

          lines.push("");
          lines.push(`Channels: ${stats.channels}`);
          lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

          context.ui.notify(lines.join("\n"), "info");
          break;
        }
      case "toggletools": {
        const cfg3 = loadConfig();
        cfg3.hideToolCalls = !cfg3.hideToolCalls;
        saveConfig(cfg3);
        const toolState = cfg3.hideToolCalls ? "hidden" : "shown";
        context.ui.notify(`🔧 Tool calls ${toolState} in remote messages`, "info");
        break;
      }
        default:
          context.ui.notify(`Unknown subcommand: ${subcommand}. Run /msg-bridge help`, "warning");
          break;
      }
    },
  });

  /**
   * Register send_bridge_message tool — allows the agent to proactively send
   * messages to remote users, e.g. for scheduled summaries or follow-ups.
   */
  pi.registerTool({
    name: "send_bridge_message",
    label: "Send Bridge Message",
    description:
      "Send a message to a remote user via the messenger bridge. " +
      "Use this to proactively notify users (e.g., scheduled summaries, alerts, follow-ups) " +
      "without waiting for them to message first. " +
      "If transport and chatId are omitted, sends to the last active conversation.",
    parameters: Type.Object({
      text: Type.String({ description: "Message content to send to the remote user" }),
      transport: Type.Optional(
        Type.String({
          description:
            "Transport type: 'slack', 'telegram', 'discord', or 'whatsapp'. " +
            "Omit to use the last active transport.",
        }),
      ),
      chatId: Type.Optional(
        Type.String({
          description:
            "Target chat/channel ID. Omit to use the last active chat.",
        }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const { text, transport, chatId } = params;

      // Resolve target: pendingRemoteChat > config.lastChatTargets > error
      let targetTransport = transport || pendingRemoteChat?.transport;
      let targetChat = chatId || pendingRemoteChat?.chatId;

      if (!targetTransport || !targetChat) {
        // Try persisted fallback per transport
        const fileConfig = loadFileConfig();
        const savedTargets = fileConfig.lastChatTargets || {};

        if (!targetTransport && targetChat) {
          // Have chatId but no transport — search saved targets
          for (const [t, s] of Object.entries(savedTargets)) {
            if (s.chatId === targetChat) {
              targetTransport = t;
              break;
            }
          }
        } else if (targetTransport && !targetChat) {
          // Have transport but no chatId — look up by transport
          const saved = savedTargets[targetTransport];
          if (saved) targetChat = saved.chatId;
        } else {
          // Neither specified — use the only saved target if there's exactly one
          const entries = Object.entries(savedTargets);
          if (entries.length === 1) {
            targetTransport = entries[0][0];
            targetChat = entries[0][1].chatId;
          }
        }
      }

      if (!targetTransport || !targetChat) {
        const savedTargets = loadFileConfig().lastChatTargets || {};
        const savedList = Object.entries(savedTargets)
          .map(([t, s]) => `${t} (chat ${s.chatId}${s.username ? `, @${s.username}` : ""})`)
          .join("; ");
        return {
          content: [
            {
              type: "text",
              text:
                "❌ No target chat available. " +
                (savedList
                  ? `Known targets: ${savedList}. Specify transport and chatId explicitly.`
                  : "A user must message the bot first to establish a conversation, " +
                    "or specify both transport and chatId explicitly. ") +
                "Connected transports: " +
                transportManager
                  .getAllTransports()
                  .filter((t) => t.isConnected)
                  .map((t) => t.type)
                  .join(", ") || "none",
            },
          ],
          details: undefined,
        };
      }

      try {
        await transportManager.sendMessage(targetChat, targetTransport, text);
        return {
          content: [
            {
              type: "text",
              text: `✅ Message sent to ${targetTransport} chat.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to send message via ${targetTransport}: ${(err as Error).message}`,
            },
          ],
          details: undefined,
        };
      }
    },
  });
}
