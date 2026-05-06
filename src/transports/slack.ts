import type { Logger as SlackSdkLogger, LogLevel as SlackSdkLogLevel } from "@slack/logger";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { ExternalMessage } from "../types.js";
import type { ITransportProvider } from "./interface.js";

// Dynamic import for ESM modules
type App = any;
type SlackLogLevel = SlackSdkLogLevel;
type SlackNotificationType = "info" | "warning" | "error";

type SlackProviderOptions = {
  notify?: (message: string, type: SlackNotificationType) => void;
};

type SlackLogger = SlackSdkLogger;

const SOCKET_ISSUE_NOTIFICATION_WINDOW_MS = 30_000;
const GENERIC_NOTIFICATION_WINDOW_MS = 10_000;

async function loadSlackBolt() {
  const slack = await import("@slack/bolt");
  return slack;
}

/**
 * Slack transport provider using @slack/bolt
 */
export class SlackProvider implements ITransportProvider {
  readonly type = "slack";
  private app: App | null = null;
  private _isConnected = false;
  private botUserId: string = "";
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = "";
  private warnedMissingUsersReadScope = false;
  private notificationTimestamps = new Map<string, number>();

  // Cache user info to avoid repeated API calls
  private userCache: Map<string, string> = new Map();
  // Cache channel info to detect DMs vs channels
  private channelCache: Map<string, { isDM: boolean; name?: string }> = new Map();

  constructor(
    private config: { botToken: string; appToken: string },
    private auth: ChallengeAuth,
    private options: SlackProviderOptions = {},
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  private extractDisplayName(user: any): string | undefined {
    const candidates = [
      user?.profile?.display_name,
      user?.profile?.display_name_normalized,
      user?.profile?.real_name,
      user?.real_name,
      user?.name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private extractMessageUsername(message: any): string | undefined {
    const candidates = [
      message?.user_profile?.display_name,
      message?.user_profile?.real_name,
      message?.username,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private notify(
    message: string,
    type: SlackNotificationType,
    key?: string,
    cooldownMs: number = GENERIC_NOTIFICATION_WINDOW_MS,
  ): void {
    if (!this.options.notify) {
      return;
    }

    if (key) {
      const now = Date.now();
      const lastNotifiedAt = this.notificationTimestamps.get(key);
      if (lastNotifiedAt !== undefined && now - lastNotifiedAt < cooldownMs) {
        return;
      }
      this.notificationTimestamps.set(key, now);
    }

    this.options.notify(message, type);
  }

  private formatValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (value instanceof Error) {
      return value.message || value.name;
    }

    if (typeof value === "object" && value !== null && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private formatLoggerMessage(name: string, messages: unknown[]): string {
    const renderedMessages = messages
      .map((message) => this.normalizeText(this.formatValue(message)))
      .filter((message) => message.length > 0);

    if (renderedMessages.length === 0) {
      return name;
    }

    return `${name} ${renderedMessages.join(" ")}`.trim();
  }

  private extractErrorMessage(error: unknown): string {
    return this.normalizeText(this.formatValue(error));
  }

  private maybeNotifyTransientSocketIssue(message: string): boolean {
    const normalized = this.normalizeText(message);

    if (
      normalized.includes("A ping wasn't received from the server before the timeout") ||
      normalized.includes("A pong wasn't received from the server before the timeout") ||
      normalized.includes("Failed to send ping to Slack") ||
      normalized.includes("WebSocket error")
    ) {
      this.notify(
        "⚠️ Slack websocket connection looks unstable. Reconnecting automatically...",
        "warning",
        "slack-websocket-issue",
        SOCKET_ISSUE_NOTIFICATION_WINDOW_MS,
      );
      return true;
    }

    return false;
  }

  private createLogger(initialLevel: SlackLogLevel = "warn" as SlackLogLevel): SlackLogger {
    let level = initialLevel;
    let name = "slack";

    return {
      getLevel: () => level,
      setLevel: (nextLevel: SlackLogLevel) => {
        level = nextLevel;
      },
      setName: (nextName: string) => {
        name = nextName;
      },
      debug: () => {
        // Intentionally silent in TUI mode.
      },
      info: () => {
        // Intentionally silent in TUI mode.
      },
      warn: (...messages: unknown[]) => {
        this.maybeNotifyTransientSocketIssue(this.formatLoggerMessage(name, messages));
      },
      error: (...messages: unknown[]) => {
        this.maybeNotifyTransientSocketIssue(this.formatLoggerMessage(name, messages));
      },
    };
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { botToken, appToken } = this.config;

    if (!botToken || !appToken) {
      throw new Error("Slack requires both botToken (xoxb-...) and appToken (xapp-...)");
    }

    const slack = await loadSlackBolt();

    this.app = new slack.App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logger: this.createLogger(slack.LogLevel.WARN),
    });

    // Get bot's own user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || "";
    } catch (_error) {
      this.notify(
        "⚠️ Slack connected, but bot identity lookup failed. Mention detection in channels may be limited.",
        "warning",
        "slack-bot-identity",
        SOCKET_ISSUE_NOTIFICATION_WINDOW_MS,
      );
    }

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, message edits, deletes, etc.
      if (message.subtype) {
        return;
      }

      // TypeScript type guard for regular messages
      if (!("user" in message) || !("text" in message) || !message.text) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const text = message.text;
      const ts = message.ts;

      // Filter out duplicate messages
      if (ts === this.lastProcessedMessageId) {
        return;
      }
      this.lastProcessedMessageId = ts;

      // Get username from cache or fetch
      let username: string = this.userCache.get(userId) || this.extractMessageUsername(message) || userId;
      if (!this.userCache.has(userId)) {
        const hintedName = this.extractMessageUsername(message);
        if (hintedName) {
          username = hintedName;
          this.userCache.set(userId, username);
        } else {
          try {
            const userInfo = await client.users.info({ user: userId });
            const fetchedName = this.extractDisplayName(userInfo.user);
            username = fetchedName || userId;
            this.userCache.set(userId, username);
          } catch (error: any) {
            if (!this.warnedMissingUsersReadScope && error?.data?.error === "missing_scope") {
              this.warnedMissingUsersReadScope = true;
              this.notify(
                "⚠️ Slack app is missing users:read. Human-friendly usernames may not be shown until you add the scope and reinstall the app.",
                "warning",
                "slack-users-read-scope",
                SOCKET_ISSUE_NOTIFICATION_WINDOW_MS,
              );
            }
            username = userId;
            this.userCache.set(userId, username);
          }
        }
      }

      // Get channel info from cache or fetch (to detect DM vs channel)
      let channelInfo = this.channelCache.get(channelId);
      if (!channelInfo) {
        try {
          const convInfo = await client.conversations.info({ channel: channelId });
          const conv = convInfo.channel;
          // is_im = direct message, is_mpim = multi-party DM
          const isDM = conv?.is_im === true || conv?.is_mpim === true;
          const name = typeof conv?.name === "string" ? conv.name : undefined;
          channelInfo = { isDM, name };
          this.channelCache.set(channelId, channelInfo);
        } catch {
          // Default to assuming it's a DM if we can't fetch info
          channelInfo = { isDM: true };
          this.channelCache.set(channelId, channelInfo);
        }
      }

      // Detect bot mention: <@BOT_USER_ID>
      const wasMentioned = this.botUserId
        ? text.includes(`<@${this.botUserId}>`)
        : false;

      const isGroupChat = !channelInfo.isDM;

      // Check authorization
      const sendMessageToUser = async (cId: string, outgoingText: string) => {
        if (this.app) {
          await this.app.client.chat.postMessage({
            channel: cId,
            text: outgoingText,
          });
        }
      };

      const isAuthorized = await this.auth.checkAuthorization(
        userId,
        channelId,
        username,
        isGroupChat,
        wasMentioned,
        sendMessageToUser,
        this.type,
      );

      // Handle admin commands and challenge codes in DM
      if (!isGroupChat && (text.startsWith("/") || text.match(/^\d{6}$/))) {
        const handled = await this.auth.handleAdminCommand(
          text,
          channelId,
          userId,
          async (outgoingText) => await this.sendMessage(channelId, outgoingText),
          this.type,
        );
        if (handled) {
          return;
        }
      }

      if (!isAuthorized) {
        return; // Auth handler already sent challenge/error messages
      }

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,
          chatName: isGroupChat ? channelInfo.name : undefined,
          transport: this.type,
          content: text.trim(),
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
        };

        this.messageHandler(externalMessage);
      }
    });

    // Handle errors
    this.app.error(async (error: any) => {
      const message = this.extractErrorMessage(error);
      if (this.maybeNotifyTransientSocketIssue(message)) {
        return;
      }

      if (this.errorHandler) {
        this.errorHandler(new Error(message));
      }
    });

    try {
      await this.app.start();
      this._isConnected = true;
    } catch (error) {
      throw new Error(`Slack connection failed: ${this.extractErrorMessage(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors
      }
      this.app = null;
    }
    this._isConnected = false;
    this.userCache.clear();
    this.channelCache.clear();
    this.notificationTimestamps.clear();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!text?.trim()) return;

    try {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text: text,
      });
    } catch (error) {
      throw new Error(`Slack send failed: ${this.extractErrorMessage(error)}`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't support typing indicators for bots
    // We could potentially add a reaction or use a "thinking" message
    // but for now we'll just skip it
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
