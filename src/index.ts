/**
 * Port42 channel adapter for OpenClaw.
 *
 * Bridges OpenClaw agents into Port42 companion computing channels.
 * Users install with: openclaw plugins install port42-openclaw
 * Then add a channel with a Port42 invite link.
 */

import { parseInviteLink, type InviteConfig } from './invite';
import { Port42Connection, type ConnectionConfig } from './connection';
import { createHash } from 'node:crypto';

export interface Port42ChannelConfig {
  invite?: string;
  gateway?: string;
  channelId?: string;
  encryptionKey?: string;
  displayName: string;
  trigger?: 'mention' | 'all';
}

interface PluginAPI {
  registerChannel(
    name: string,
    handler: ChannelHandler,
  ): void;
  log: {
    info(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
}

interface ChannelHandler {
  connect(config: Port42ChannelConfig): Promise<ChannelInstance>;
}

interface ChannelInstance {
  send(content: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Generate a stable sender ID from the display name.
 * This ensures the same agent gets the same ID across restarts
 * so the gateway recognizes it as the same peer.
 */
function stableSenderId(displayName: string): string {
  const hash = createHash('sha256').update(`port42-openclaw:${displayName}`).digest('hex');
  // Format as UUID-like string for compatibility
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Resolve config from either an invite link or explicit fields.
 */
function resolveConfig(config: Port42ChannelConfig): {
  gateway: string;
  channelId: string;
  encryptionKey: string | null;
} {
  if (config.invite) {
    const parsed = parseInviteLink(config.invite);
    return {
      gateway: config.gateway || parsed.gateway,
      channelId: config.channelId || parsed.channelId,
      encryptionKey: config.encryptionKey || parsed.encryptionKey,
    };
  }

  if (!config.gateway || !config.channelId) {
    throw new Error('Port42 channel requires either an invite link or explicit gateway + channelId');
  }

  return {
    gateway: config.gateway,
    channelId: config.channelId,
    encryptionKey: config.encryptionKey || null,
  };
}

/**
 * OpenClaw plugin entry point.
 */
export function register(api: PluginAPI): void {
  api.registerChannel('port42', {
    async connect(config: Port42ChannelConfig): Promise<ChannelInstance> {
      const resolved = resolveConfig(config);
      const senderId = stableSenderId(config.displayName);
      const trigger = config.trigger || 'mention';

      api.log.info(`Connecting to Port42 channel ${resolved.channelId} as "${config.displayName}"`);

      return new Promise<ChannelInstance>((resolve, reject) => {
        let messageHandler: ((senderName: string, content: string, messageId: string) => void) | null = null;

        const connection = new Port42Connection({
          gateway: resolved.gateway,
          channelId: resolved.channelId,
          senderId,
          displayName: config.displayName,
          encryptionKey: resolved.encryptionKey,
          trigger,

          onMessage(senderName, content, messageId) {
            if (messageHandler) {
              messageHandler(senderName, content, messageId);
            }
          },

          onConnected() {
            api.log.info(`Connected to Port42 as "${config.displayName}"`);
            resolve({
              async send(content: string) {
                connection.sendTyping(true);
                // Small delay so typing indicator shows before response
                await new Promise((r) => setTimeout(r, 100));
                connection.sendResponse(content);
                connection.sendTyping(false);
              },

              async disconnect() {
                connection.disconnect();
                api.log.info(`Disconnected from Port42`);
              },
            });
          },

          onDisconnected() {
            api.log.debug('Port42 connection lost');
          },

          onPresence(onlineIds) {
            api.log.debug(`Port42 presence: ${onlineIds.length} online`);
          },
        });

        // Wire up the message handler for OpenClaw to receive inbound messages
        messageHandler = (senderName, content, _messageId) => {
          api.log.debug(`[${senderName}]: ${content.slice(0, 100)}`);
        };

        connection.connect();

        // Timeout if we can't connect within 15 seconds
        setTimeout(() => {
          reject(new Error('Port42 connection timeout (15s)'));
        }, 15000);
      });
    },
  });
}

// Re-export modules for standalone use
export { parseInviteLink } from './invite';
export { Port42Connection } from './connection';
export type { ConnectionConfig } from './connection';
export type { InviteConfig } from './invite';
export { encrypt, decrypt } from './crypto';
