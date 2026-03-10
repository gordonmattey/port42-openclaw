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
  owner?: string;
  trigger?: 'mention' | 'all';
  enabled?: boolean;
}

// ── Plugin runtime (set during registration) ──

let pluginRuntime: any = null;

// ── Helpers ──

function stableSenderId(name: string): string {
  // Use a unique namespace to avoid collision with Port42 native app companions
  const h = createHash('sha256').update(`openclaw-channel-adapter:${name}`).digest('hex');
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
  const senderOwner: string | null = account.owner || null;

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
    senderOwner,
    trigger: account.trigger || 'mention',
    onMessage: onMessage || (() => {}),
    onConnected: () => console.log(`[port42] Connected as "${account.displayName}"`),
    onDisconnected: () => console.log(`[port42] Disconnected: ${account.accountId}`),
  });

  conn.connect(true);
  return conn;
}

// ── Active connections (keyed by accountId for outbound lookups) ──

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

    defaultAccountId: (cfg: any): string | undefined => {
      const accounts = cfg.channels?.port42?.accounts ?? {};
      return Object.keys(accounts)[0];
    },

    resolveAccount: (cfg: any, accountId?: string | null): Port42Account => {
      const accounts = cfg.channels?.port42?.accounts ?? {};
      const id = accountId ?? Object.keys(accounts)[0] ?? "default";
      const section = accounts[id];
      return {
        accountId: id,
        invite: section?.invite,
        gateway: section?.gateway,
        channelId: section?.channelId,
        encryptionKey: section?.encryptionKey,
        token: section?.token,
        displayName: section?.displayName ?? "Port42 Agent",
        owner: section?.owner,
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
    deliveryMode: "gateway" as const,
    textChunkLimit: 4096,

    sendText: async (ctx: any) => {
      const conn = connections.get(ctx.accountId);
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
    startAccount: async (ctx: any) => {
      const account = port42Channel.config.resolveAccount(ctx.cfg, ctx.accountId);
      console.log(`[port42] startAccount "${ctx.accountId}" (existing conn: ${connections.has(ctx.accountId)})`);

      // Disconnect any existing connection for this account
      const existing = connections.get(ctx.accountId);
      if (existing) {
        console.log(`[port42] Cleaning up previous connection for "${ctx.accountId}"`);
        existing.disconnect();
        connections.delete(ctx.accountId);
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Get the channel ID from the invite for routing
      let p42ChannelId = account.channelId;
      if (!p42ChannelId && account.invite) {
        p42ChannelId = parseInviteLink(account.invite).channelId;
      }

      const conn = connectAccount(account, async (senderName, content, messageId) => {
        try {
          const rt = pluginRuntime;

          const route = rt.channel.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: "port42",
            accountId: ctx.accountId,
            peer: { kind: "group", id: p42ChannelId },
          });

          const inboundCtx = rt.channel.reply.finalizeInboundContext({
            Body: content,
            RawBody: content,
            CommandBody: content,
            From: `port42:${senderName}`,
            To: `port42:${p42ChannelId}`,
            SessionKey: route.sessionKey,
            AccountId: ctx.accountId,
            ChatType: "group",
            ConversationLabel: senderName,
            SenderName: senderName,
            SenderId: `port42:${stableSenderId(senderName)}`,
            Provider: "port42",
            Surface: "port42",
            MessageSid: messageId,
            OriginatingChannel: "port42",
            OriginatingTo: `port42:${p42ChannelId}`,
          });

          await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload: any) => {
                const conn = connections.get(ctx.accountId);
                if (conn && payload.text) {
                  conn.sendTyping(true);
                  await new Promise((r) => setTimeout(r, 100));
                  conn.sendResponse(payload.text);
                  conn.sendTyping(false);
                }
              },
            },
            replyOptions: {},
          });
        } catch (err: any) {
          console.error(`[port42] inbound error: ${err.message}`);
        }
      });

      connections.set(ctx.accountId, conn);
      ctx.setStatus?.("connected");

      // Park the promise until OpenClaw signals shutdown
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) { resolve(); return; }
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      console.log(`[port42] Shutting down account "${ctx.accountId}"`);
      conn.disconnect();
      connections.delete(ctx.accountId);
    },
  },
};

// ── Plugin entry point ──

export default function (api: any) {
  pluginRuntime = api.runtime;
  api.registerChannel({ plugin: port42Channel });

  // Register CLI: openclaw port42 join --invite "..."
  api.registerCli(
    ({ program }: any) => {
      const p42 = program.command("port42").description("Port42 companion computing");

      p42.command("join")
        .description("Join a Port42 channel with an invite link")
        .requiredOption("--invite <url>", "Port42 invite link")
        .requiredOption("--agent <id>", "Agent to connect (used as display name in Port42)")
        .option("--account <id>", "Account identifier (defaults to agent id)")
        .option("--owner <name>", "Owner name shown in Port42 (e.g. your gateway name)")
        .option("--trigger <mode>", "Respond to 'mention' or 'all'", "mention")
        .action((opts: any) => {
          const fs = require('node:fs');
          const path = require('node:path');
          const os = require('node:os');

          const accountId = opts.account || opts.agent;
          const owner = opts.owner || 'clawd';
          const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

          let existing: any = {};
          try {
            existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          } catch {
            // No existing config, start fresh
          }

          // Ensure structure exists
          if (!existing.channels) existing.channels = {};
          if (!existing.channels.port42) existing.channels.port42 = {};
          if (!existing.channels.port42.accounts) existing.channels.port42.accounts = {};

          existing.channels.port42.accounts[accountId] = {
            invite: opts.invite,
            displayName: opts.agent,
            owner,
            trigger: opts.trigger,
          };

          fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');

          console.log(`Added Port42 channel "${accountId}" with agent "${opts.agent}"`);
          console.log(`\nNext steps:`);
          console.log(`  openclaw agents bind --agent ${opts.agent} --bind port42:${accountId}`);
          console.log(`  openclaw gateway restart`);
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
