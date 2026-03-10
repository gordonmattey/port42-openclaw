/**
 * WebSocket connection to a Port42 gateway with reconnection.
 */

import WebSocket from 'ws';
import {
  type Envelope,
  createIdentify,
  createJoin,
  createLeave,
  createAck,
  createTyping,
  createMessage,
} from './protocol';
import { encrypt, decrypt } from './crypto';

export interface ConnectionConfig {
  gateway: string;
  channelId: string;
  senderId: string;
  displayName: string;
  encryptionKey: string | null;
  token: string | null;
  trigger: 'mention' | 'all';
  onMessage: (senderName: string, content: string, messageId: string) => void;
  onPresence?: (onlineIds: string[]) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export class Port42Connection {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private reconnectDelay = 3000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private identified = false;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(createLeave(this.config.channelId));
      this.ws.close();
    }
    this.ws = null;
    this.config.onDisconnected?.();
  }

  sendResponse(content: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.config.encryptionKey) {
      const payload = {
        content,
        senderName: this.config.displayName,
        senderType: "agent",
        senderOwner: null,
        replyToId: null,
      };
      const blob = encrypt(payload, this.config.encryptionKey);
      this.send(createMessage(
        this.config.channelId,
        this.config.senderId,
        this.config.displayName,
        blob,
        true,
      ));
    } else {
      this.send(createMessage(
        this.config.channelId,
        this.config.senderId,
        this.config.displayName,
        content,
        false,
      ));
    }
  }

  sendTyping(isTyping: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(createTyping(this.config.channelId, this.config.senderId, isTyping));
  }

  private openSocket(): void {
    try {
      let url = this.config.gateway;
      if (this.config.token) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(this.config.token)}`;
      }
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[port42] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectDelay = 3000;
      this.identified = false;
      // Wait for no_auth/challenge from gateway before sending identify
    });

    this.ws.on('message', (data) => {
      try {
        const envelope: Envelope = JSON.parse(data.toString());
        this.handleEnvelope(envelope);
      } catch (err) {
        console.error('[port42] Failed to parse message:', err);
      }
    });

    this.ws.on('close', () => {
      this.identified = false;
      this.config.onDisconnected?.();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[port42] WebSocket error:', err.message);
    });
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.type) {
      case 'no_auth':
        // Gateway doesn't require auth, send identify
        if (!this.identified) {
          this.send(createIdentify(this.config.senderId, this.config.displayName));
        }
        break;

      case 'welcome':
        this.identified = true;
        this.send(createJoin(this.config.channelId, [], this.config.token));
        this.config.onConnected?.();
        break;

      case 'message':
        this.handleIncomingMessage(envelope);
        break;

      case 'presence':
        if (envelope.online_ids) {
          this.config.onPresence?.(envelope.online_ids);
        }
        break;

      case 'error':
        console.error('[port42] Gateway error:', envelope.error);
        break;

      case 'ack':
        // Message delivered
        break;
    }
  }

  private handleIncomingMessage(envelope: Envelope): void {
    if (!envelope.payload || !envelope.message_id) return;

    // Ignore own messages
    if (envelope.sender_id === this.config.senderId) return;

    // ACK receipt
    this.send(createAck(envelope.message_id, this.config.channelId!));

    // Decrypt if needed
    let content: string;
    let senderName: string;

    if (envelope.payload.encrypted && this.config.encryptionKey) {
      const decrypted = decrypt(envelope.payload.content, this.config.encryptionKey);
      if (!decrypted) {
        console.error('[port42] Decryption failed for message:', envelope.message_id);
        return;
      }
      content = decrypted.content;
      senderName = decrypted.senderName || envelope.sender_name || 'Unknown';
    } else {
      content = envelope.payload.content;
      senderName = envelope.payload.senderName || envelope.sender_name || 'Unknown';
    }

    // Check trigger rules
    if (this.config.trigger === 'mention') {
      const mentionPattern = new RegExp(`@${this.config.displayName}\\b`, 'i');
      if (!mentionPattern.test(content)) return;
    }

    this.config.onMessage(senderName, content, envelope.message_id);
  }

  private send(envelope: Envelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    console.log(`[port42] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => this.openSocket(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
