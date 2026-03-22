/**
 * Parse Port42 HTTPS invite links into connection config.
 *
 * Direct invite format (gateway host == invite host):
 * https://<gateway-host>/invite?id=<channel-uuid>&name=<channel-name>&key=<...>&token=<...>&host=<...>
 *
 * Redirect invite format (port42.ai landing page with explicit gateway param):
 * https://port42.ai/invite.html?gateway=wss://<gateway-host>&id=<channel-uuid>&...
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
  const token = url.searchParams.get('token') || null;
  const host = url.searchParams.get('host') || null;

  // Parse key manually to preserve '+' chars (searchParams decodes + as space)
  const keyMatch = url.search.match(/[?&]key=([^&]+)/);
  const encryptionKey = keyMatch ? decodeURIComponent(keyMatch[1]) : null;

  // Use explicit gateway= param if present (port42.ai redirect format),
  // otherwise derive from the invite host (direct gateway format).
  const gatewayParam = url.searchParams.get('gateway');
  let gateway: string;
  if (gatewayParam) {
    // Normalise: strip trailing slash, ensure /ws path
    const base = gatewayParam.replace(/\/+$/, '');
    gateway = base.endsWith('/ws') ? base : `${base}/ws`;
  } else {
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    gateway = `${protocol}//${url.host}/ws`;
  }

  return { gateway, channelId, channelName, encryptionKey, token, host };
}
