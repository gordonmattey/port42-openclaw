/**
 * Parse Port42 HTTPS invite links into connection config.
 *
 * Invite format:
 * https://<host>/invite?id=<channel-uuid>&name=<channel-name>&key=<url-encoded-base64-aes-key>&token=<gateway-token>&host=<host-name>
 */

export interface InviteConfig {
  gateway: string;
  channelId: string;
  channelName: string;
  encryptionKey: string | null;
  token: string | null;
  host: string | null;
}

export function parseInviteLink(invite: string): InviteConfig {
  const url = new URL(invite);

  const channelId = url.searchParams.get('id');
  if (!channelId) {
    throw new Error('Invite link missing channel id (id= parameter)');
  }

  const channelName = url.searchParams.get('name') || 'unknown';
  const encryptionKey = url.searchParams.get('key') || null;
  const token = url.searchParams.get('token') || null;
  const host = url.searchParams.get('host') || null;

  // Derive WebSocket URL from the HTTPS host
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const gateway = `${protocol}//${url.host}/ws`;

  return { gateway, channelId, channelName, encryptionKey, token, host };
}
