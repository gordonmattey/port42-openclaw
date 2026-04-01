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
  createCall,
} from './protocol';
import { encrypt, decrypt } from './crypto';

export interface ConnectionConfig {
  gateway: string;
  channelId: string;
  senderId: string;
  displayName: string;
  encryptionKey: string | null;
  token: string | null;
  senderOwner: string | null;
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

  private pendingCalls = new Map<string, { resolve: (val: any) => void, reject: (err: Error) => void }>();

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  connect(autoReconnect = true): void {
    this.shouldReconnect = autoReconnect;
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
        senderOwner: this.config.senderOwner,
        replyToId: null,
      };
      const blob = encrypt(payload, this.config.encryptionKey);
      this.send(createMessage(
        this.config.channelId,
        this.config.senderId,
        this.config.displayName,
        blob,
        true,
        this.config.senderOwner,
      ));
    } else {
      this.send(createMessage(
        this.config.channelId,
        this.config.senderId,
        this.config.displayName,
        content,
        false,
        this.config.senderOwner,
      ));
    }
  }

  sendTyping(isTyping: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send(createTyping(this.config.channelId, this.config.senderId, isTyping));
  }

  async call(method: string, args: any[] = []): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Port42');
    }

    const envelope = createCall(this.config.channelId, method, args);
    const callId = envelope.call_id!;

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject });
      this.send(envelope);

      setTimeout(() => {
        if (this.pendingCalls.has(callId)) {
          this.pendingCalls.delete(callId);
          reject(new Error("Call " + method + " timed out"));
        }
      }, 30000);
    });
  }

  private async openSocket(): Promise<void> {
    let url = this.config.gateway;
    if (this.config.token) {
      const sep = url.includes('?') ? '&' : '?';
      url = "" + url + sep + "token=" + encodeURIComponent(this.config.token);
    }

    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    try {
      const res = await fetch(httpUrl, {
        method: 'HEAD',
        headers: { 'ngrok-skip-browser-warning': '1' },
        signal: AbortSignal.timeout(5000),
      });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        console.log('[port42] Gateway returned HTML (tunnel not ready or interstitial). Retrying...');
        this.scheduleReconnect();
        return;
      }
    } catch {
    }

    try {
      this.ws = new WebSocket(url, {
        headers: { 'ngrok-skip-browser-warning': '1' },
      } as any);
    } catch (err) {
      console.error('[port42] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectDelay = 3000;
      this.identified = false;
    });

    this.ws.on('message', (data) => {
      try {
        const envelope: Envelope = JSON.parse(data.toString());
        this.handleEnvelope(envelope);
      } catch (err) {
        console.error('[port42] Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      const msg = reason?.toString() || '';
      console.log("[port42] WS closed: code=" + code + " reason=" + msg);
      this.identified = false;
      if (msg === 'replaced by new connection') {
        return;
      }
      this.config.onDisconnected?.();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      const msg = err.message || '';
      if (msg.includes('packet length') || msg.includes('wrong tag') || msg.includes('SSL')) {
        console.log('[port42] Gateway not ready (got HTTP instead of WebSocket upgrade). Retrying...');
      } else {
        console.error('[port42] WebSocket error:', msg);
      }
    });
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.type) {
      case 'no_auth':
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

      case 'response':
        this.handleRPCResponse(envelope);
        break;

      case 'presence':
        if (envelope.online_ids) {
          this.config.onPresence?.(envelope.online_ids);
        }
        break;

      case 'error':
        console.error('[port42] Gateway error:', envelope.error);
        if (envelope.call_id && this.pendingCalls.has(envelope.call_id)) {
          const call = this.pendingCalls.get(envelope.call_id)!;
          this.pendingCalls.delete(envelope.call_id);
          call.reject(new Error(envelope.error || 'unknown gateway error'));
        }
        break;

      case 'ack':
        break;
    }
  }

  private handleRPCResponse(envelope: Envelope): void {
    const callId = envelope.call_id;
    if (!callId || !this.pendingCalls.has(callId)) return;

    const call = this.pendingCalls.get(callId)!;
    this.pendingCalls.delete(callId);

    if (envelope.error) {
      call.reject(new Error(envelope.error));
    } else if (envelope.payload) {
      try {
        const result = JSON.parse(envelope.payload.content);
        call.resolve(result);
      } catch {
        call.resolve(envelope.payload.content);
      }
    } else {
      call.resolve(null);
    }
  }

  private handleIncomingMessage(envelope: Envelope): void {
    if (!envelope.payload || !envelope.message_id) return;
    if (envelope.sender_id === this.config.senderId) return;
    this.send(createAck(envelope.message_id, this.config.channelId!));

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

    if (this.config.trigger === 'mention') {
      const mentionPattern = new RegExp("@" + this.config.displayName + "\\b", 'i');
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
    console.log("[port42] Reconnecting in " + (this.reconnectDelay / 1000) + "s...");
    setTimeout(() => this.openSocket(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
