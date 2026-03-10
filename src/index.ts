/**
 * Port42 channel adapter for OpenClaw.
 *
 * Bridges OpenClaw agents into Port42 companion computing channels.
 * Users install with: openclaw plugins install port42-openclaw
 * Then join with: openclaw port42 join --invite "..."
 */

import { parseInviteLink } from './invite';
import { Port42Connection } from './connection';
import { createHash } from 'node:crypto';

// ── Types ──

interface Port42Account {
  accountId: string;
  invite?: string;
  gateway?: string;
  channelId?: string;
  encryptionKey?: string;
  token?: string;
  displayName: string;
  trigger?: 'mention' | 'all';
  enabled?: boolean;
}

// ── Helpers ──

function stableSenderId(name: string): string {
  const h = createHash('sha256').update(`port42-openclaw:${name}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

function connectAccount(
  account: Port42Account,
  onMessage?: (senderName: string, content: string, messageId: string) => void,
): Port42Connection {
  let gateway: string;
  let channelId: string;
  let encryptionKey: string | null = null;
  let token: string | null = null;

  if (account.invite) {
    const parsed = parseInviteLink(account.invite);
    gateway = account.gateway || parsed.gateway;
    channelId = account.channelId || parsed.channelId;
    encryptionKey = account.encryptionKey || parsed.encryptionKey;
    token = account.token || parsed.token;
  } else {
    gateway = account.gateway!;
    channelId = account.channelId!;
    encryptionKey = account.encryptionKey || null;
    token = account.token || null;
  }

  const conn = new Port42Connection({
    gateway,
    channelId,
    senderId: stableSenderId(account.displayName),
    displayName: account.displayName,
    encryptionKey,
    token,
    trigger: account.trigger || 'mention',
    onMessage: onMessage || (() => {}),
    onConnected: () => console.log(`[port42] Connected as "${account.displayName}"`),
    onDisconnected: () => console.log(`[port42] Disconnected: ${account.accountId}`),
  });

  conn.connect();
  return conn;
}

// ── Active connections ──

const connections = new Map<string, Port42Connection>();

// ── Channel plugin descriptor ──

const port42Channel = {
  id: "port42" as const,

  meta: {
    id: "port42",
    label: "Port42",
    selectionLabel: "Port42 (Companion Computing)",
    docsPath: "/channels/port42",
    blurb: "Bring agents into Port42 companion computing channels.",
    aliases: ["p42"],
  },

  capabilities: { chatTypes: ["direct", "group"] },

  config: {
    listAccountIds: (cfg: any): string[] =>
      Object.keys(cfg.channels?.port42?.accounts ?? {}),

    resolveAccount: (cfg: any, accountId?: string | null): Port42Account => {
      const section = cfg.channels?.port42?.accounts?.[accountId ?? "default"];
      return {
        accountId: accountId ?? "default",
        invite: section?.invite,
        gateway: section?.gateway,
        channelId: section?.channelId,
        encryptionKey: section?.encryptionKey,
        token: section?.token,
        displayName: section?.displayName ?? "Port42 Agent",
        trigger: section?.trigger ?? "mention",
        enabled: section?.enabled ?? true,
      };
    },

    isConfigured: (account: Port42Account): boolean =>
      Boolean(account.invite || (account.gateway && account.channelId)),

    describeAccount: (account: Port42Account) => ({
      accountId: account.accountId,
      name: account.displayName,
      enabled: account.enabled ?? true,
      configured: Boolean(account.invite || (account.gateway && account.channelId)),
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,

    sendText: async (ctx: any) => {
      const account = port42Channel.config.resolveAccount(ctx.cfg, ctx.accountId);
      const conn = connections.get(account.accountId);
      if (!conn) {
        return { ok: false, error: new Error("Port42 account not connected") };
      }
      conn.sendTyping(true);
      await new Promise((r) => setTimeout(r, 100));
      conn.sendResponse(ctx.text);
      conn.sendTyping(false);
      return { ok: true, timestamp: Date.now() };
    },
  },

  gateway: {
    registerHandlers: (ctx: any) => {
      const accountIds = port42Channel.config.listAccountIds(ctx.cfg);

      for (const id of accountIds) {
        const account = port42Channel.config.resolveAccount(ctx.cfg, id);
        if (!account.enabled || !port42Channel.config.isConfigured(account)) continue;

        // Skip if already connected
        if (connections.has(id)) continue;

        const conn = connectAccount(account, (senderName, content, messageId) => {
          ctx.handleIncomingMessage?.({
            channelId: "port42",
            accountId: id,
            senderId: `port42:${senderName}`,
            senderName,
            content,
            messageId,
            chatType: "group",
          });
        });

        connections.set(id, conn);
      }
    },

    handleIncomingMessage: async (_ctx: any) => {
      // Inbound messages are routed via the registerHandlers callback
    },
  },
};

// ── Plugin entry point ──

export default function (api: any) {
  api.registerChannel({ plugin: port42Channel });

  // Register CLI: openclaw port42 join --invite "..."
  api.registerCli(
    ({ program }: any) => {
      const p42 = program.command("port42").description("Port42 companion computing");

      p42.command("join")
        .description("Join a Port42 channel with an invite link")
        .requiredOption("--invite <url>", "Port42 invite link")
        .option("--name <name>", "Display name for your agent", "OpenClaw Agent")
        .option("--account <id>", "Account identifier", "default")
        .option("--trigger <mode>", "Respond to 'mention' or 'all'", "mention")
        .action((opts: any) => {
          const config = {
            invite: opts.invite,
            displayName: opts.name,
            trigger: opts.trigger,
          };

          console.log(`\nAdd this to your openclaw.json:\n`);
          console.log(JSON.stringify({
            channels: {
              port42: {
                accounts: {
                  [opts.account]: config,
                },
              },
            },
          }, null, 2));
          console.log(`\nThen run: openclaw gateway restart`);
        });
    },
    { commands: ["port42"] },
  );
}

// Re-export for standalone use
export { parseInviteLink } from './invite';
export { Port42Connection } from './connection';
export type { ConnectionConfig } from './connection';
export type { InviteConfig } from './invite';
export { encrypt, decrypt } from './crypto';
