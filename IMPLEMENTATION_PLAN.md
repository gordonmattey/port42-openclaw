# port42-openclaw v0.4.0 Implementation Plan

## Problem

The current plugin doesn't conform to OpenClaw's channel adapter API. It uses a custom `PluginAPI` interface with `registerChannel(name, handler)` when OpenClaw expects `api.registerChannel({ plugin: channelObject })` with a structured channel descriptor. This causes:

- `unknown channel id: port42` — OpenClaw doesn't know port42 is a valid channel
- `plugin not found: port42-openclaw` — manifest missing `configSchema`, plugin can't load

## Key Findings from OpenClaw Docs

1. **Inbound messages** are handled via `gateway.registerHandlers` and `gateway.handleIncomingMessage` on the `ChannelGatewayAdapter`. The gateway context provides runtime helpers for routing messages to agents.
2. **Lifecycle** is managed by the gateway adapter. OpenClaw calls `registerHandlers` on startup, which is where we open the WebSocket connection.
3. **CLI**: Plugins register top-level commands via `api.registerCli()` using commander.js. We can't add flags to `channels add`, but we can register our own `port42` command (e.g. `openclaw port42 join --invite "..."`).
4. **Package.json** should use `"openclaw": { "plugin": "./openclaw.plugin.json" }` (not `"extensions"`). The extensions array format is for bundled multi-extension packs.

## Files Changed

### 1. `src/index.ts` — Complete rewrite

Replace the current named `register()` export with a `default` export function that registers a proper `ChannelPlugin` object.

**Channel descriptor shape:**

```ts
const port42Channel = {
  id: "port42",
  meta: {
    id: "port42",
    label: "Port42",
    selectionLabel: "Port42 (Companion Computing)",
    docsPath: "/channels/port42",
    blurb: "Bring agents into Port42 companion computing channels.",
    aliases: ["p42"],
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: { listAccountIds, resolveAccount, isConfigured, describeAccount },
  outbound: { deliveryMode: "direct", textChunkLimit: 4096, sendText },
  gateway: { registerHandlers, handleIncomingMessage },
};
```

**Config adapter** reads from `cfg.channels.port42.accounts.*`:

```ts
config: {
  listAccountIds: (cfg) => Object.keys(cfg.channels?.port42?.accounts ?? {}),
  resolveAccount: (cfg, accountId) => {
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
  isConfigured: (account) => Boolean(account.invite || (account.gateway && account.channelId)),
  describeAccount: (account) => ({
    accountId: account.accountId,
    name: account.displayName,
    enabled: account.enabled ?? true,
    configured: Boolean(account.invite || (account.gateway && account.channelId)),
  }),
},
```

**Outbound adapter** sends messages through cached `Port42Connection` instances:

```ts
outbound: {
  deliveryMode: "direct",
  textChunkLimit: 4096,
  sendText: async (ctx) => {
    const account = port42Channel.config.resolveAccount(ctx.cfg, ctx.accountId);
    const conn = connections.get(account.accountId);
    if (!conn) return { ok: false, error: new Error("Not connected") };
    conn.sendResponse(ctx.text);
    return { ok: true, timestamp: Date.now() };
  },
},
```

**Gateway adapter** connects all configured accounts on startup and routes inbound messages:

```ts
gateway: {
  registerHandlers: (ctx) => {
    const accountIds = port42Channel.config.listAccountIds(ctx.cfg);
    for (const id of accountIds) {
      const account = port42Channel.config.resolveAccount(ctx.cfg, id);
      if (!account.enabled || !port42Channel.config.isConfigured(account)) continue;

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
  handleIncomingMessage: async () => {
    // Handled via registerHandlers callback
  },
},
```

**CLI command** for joining channels from the command line:

```ts
api.registerCli(
  ({ program }) => {
    const p42 = program.command("port42").description("Port42 companion computing");
    p42.command("join")
      .description("Join a Port42 channel with an invite link")
      .requiredOption("--invite <url>", "Port42 invite link")
      .option("--name <name>", "Display name for your agent", "OpenClaw Agent")
      .option("--account <id>", "Account identifier", "default")
      .option("--trigger <mode>", "Respond to 'mention' or 'all'", "mention")
      .action(async (opts) => {
        console.log(`Adding Port42 channel account "${opts.account}"...`);
        console.log(`\nAdd this to your openclaw.json under channels.port42.accounts.${opts.account}:`);
        console.log(JSON.stringify({
          invite: opts.invite,
          displayName: opts.name,
          trigger: opts.trigger,
        }, null, 2));
      });
  },
  { commands: ["port42"] },
);
```

### 2. `openclaw.plugin.json` — Rewrite

Add required `configSchema` (JSON Schema) and `channels` declaration:

```json
{
  "id": "port42-openclaw",
  "name": "Port42",
  "description": "Bring your OpenClaw agents into Port42 companion computing channels.",
  "channels": ["port42"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "accounts": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "invite": { "type": "string", "description": "Port42 HTTPS invite link" },
            "gateway": { "type": "string", "description": "WebSocket URL" },
            "channelId": { "type": "string", "description": "Channel UUID" },
            "encryptionKey": { "type": "string", "description": "Base64 AES-256 key" },
            "token": { "type": "string", "description": "Gateway auth token" },
            "displayName": { "type": "string", "description": "Agent display name in Port42" },
            "trigger": { "type": "string", "enum": ["mention", "all"], "default": "mention" },
            "enabled": { "type": "boolean", "default": true }
          },
          "required": ["displayName"]
        }
      }
    }
  },
  "uiHints": {
    "accounts.*.invite": { "label": "Invite Link", "help": "Paste a Port42 channel invite link" },
    "accounts.*.encryptionKey": { "sensitive": true },
    "accounts.*.token": { "sensitive": true }
  }
}
```

### 3. `package.json` — Two changes

```diff
- "version": "0.3.2"
+ "version": "0.4.0"

- "openclaw": { "extensions": ["./dist/index.js"] }
+ "openclaw": { "plugin": "./openclaw.plugin.json" }
```

### 4. `.npmignore` — New file

```
src/
tsconfig.json
.github/
```

Prevents shipping `.ts` source files that trigger OpenClaw's validator warnings.

## Unchanged Files

| File | Why |
|------|-----|
| `src/connection.ts` | WebSocket lifecycle, reconnection, encryption all work correctly |
| `src/protocol.ts` | Envelope types and builders match Port42 gateway protocol |
| `src/crypto.ts` | AES-256-GCM matches Port42's wire format |
| `src/invite.ts` | Invite link parsing works correctly |

## User Experience After v0.4.0

### Install

```bash
openclaw plugins install port42-openclaw
```

### Join a channel (CLI)

```bash
openclaw port42 join \
  --invite "https://host.ngrok-free.dev/invite?id=UUID&name=ch&key=KEY&token=TOKEN" \
  --name "Researcher"
```

### Or edit openclaw.json directly

```json
{
  "channels": {
    "port42": {
      "accounts": {
        "default": {
          "invite": "https://host.ngrok-free.dev/invite?id=UUID&name=ch&key=KEY&token=TOKEN",
          "displayName": "Researcher",
          "trigger": "mention"
        }
      }
    }
  }
}
```

### Then restart the gateway

```bash
openclaw gateway restart
```

## Open Risk

The `gateway.registerHandlers` context object (`ctx.handleIncomingMessage`) is based on patterns from the docs but not confirmed with an exact example for custom plugins. If the context API differs, the inbound routing may need adjustment. The outbound, CLI, and manifest parts are well documented and solid.

## Sources

- [Channel Plugin Development Guide](https://zread.ai/openclaw/openclaw/16-channel-plugin-development)
- [Plugins - OpenClaw](https://docs.openclaw.ai/tools/plugin)
- [Plugin Manifest](https://docs.openclaw.ai/plugins/manifest)
- [Channel Message Flow](https://deepwiki.com/openclaw/openclaw/8.3-telegram-integration)
- [Channels CLI](https://docs.openclaw.ai/cli/channels)
