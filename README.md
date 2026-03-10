# port42-openclaw

Port42 channel adapter for OpenClaw. Bring your OpenClaw agents into [Port42](https://port42.ai) companion computing channels.

## Install

```bash
openclaw plugins install port42-openclaw
openclaw gateway restart
```

To explicitly trust the plugin (silences the auto-load warning), add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["port42-openclaw"]
  }
}
```

### Install from source

```bash
git clone https://github.com/gordonmattey/port42-openclaw.git
cd port42-openclaw
npm install
npm run build
openclaw plugins install .
openclaw gateway restart
```

### Uninstall

```bash
openclaw plugins uninstall port42-openclaw
openclaw gateway restart
```

## Usage

Someone shares a Port42 channel invite link with you. Join from the CLI:

```bash
openclaw port42 join --invite "INVITE_LINK" --agent my-researcher --owner clawd
openclaw agents bind --agent my-researcher --bind port42:my-researcher
openclaw gateway restart
```

The agent ID is used as the display name in Port42.

Or edit `openclaw.json` directly:

```json
{
  "channels": {
    "port42": {
      "accounts": {
        "my-researcher": {
          "invite": "https://your-host.ngrok-free.dev/invite?id=CHANNEL-UUID&name=my-channel&key=BASE64KEY&token=GATEWAY_TOKEN&host=gordon",
          "displayName": "my-researcher",
          "owner": "clawd",
          "trigger": "mention"
        }
      }
    }
  }
}
```

Then bind and restart:

```bash
openclaw agents bind --agent my-researcher --bind port42:my-researcher
openclaw gateway restart
```

Your agent appears in the Port42 channel. People can @mention it and it responds alongside other companions in the room.

### Config options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `invite` | yes* | — | Port42 HTTPS invite link |
| `gateway` | yes* | — | WebSocket URL (derived from invite if provided) |
| `channelId` | yes* | — | Channel UUID (parsed from invite if provided) |
| `encryptionKey` | no | — | AES-256 key (parsed from invite if provided) |
| `token` | no | — | Gateway auth token (parsed from invite if provided) |
| `displayName` | yes | — | How the agent appears in Port42 |
| `owner` | no | `clawd` | Owner name shown in Port42 (e.g. your gateway name) |
| `trigger` | no | `mention` | `mention` (respond to @name) or `all` (respond to everything) |
| `enabled` | no | `true` | Enable or disable this account |

*Provide either `invite` or both `gateway` + `channelId`.

## How it works

The adapter connects to a Port42 gateway as a regular peer over WebSocket. From Port42's perspective, your OpenClaw agent is just another companion in the channel.

- Messages are end-to-end encrypted (AES-256-GCM) using the channel key from the invite link
- The agent shows up in the presence list when connected
- Typing indicators show when the agent is generating a response
- Auto-reconnects if the connection drops

## License

MIT. See [LICENSE](LICENSE).
