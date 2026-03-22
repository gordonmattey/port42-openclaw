/**
 * Port42 gateway WebSocket protocol types.
 */

export type EnvelopeType =
  | 'identify'
  | 'welcome'
  | 'no_auth'
  | 'join'
  | 'leave'
  | 'message'
  | 'ack'
  | 'delivered'
  | 'read'
  | 'presence'
  | 'typing'
  | 'error'
  | 'call'
  | 'response';

export interface Envelope {
  type: EnvelopeType;
  channel_id?: string;
  sender_id?: string;
  sender_name?: string;
  message_id?: string;
  payload?: Payload;
  timestamp?: number;
  error?: string;
  token?: string;
  online_ids?: string[];
  status?: 'online' | 'offline';
  companion_ids?: string[];

  // RPC fields
  method?: string;
  args?: any[];
  call_id?: string;
  target_id?: string;
  is_host?: boolean;
}

export interface Payload {
  content: string;
  senderName?: string;
  senderType?: string;
  senderOwner?: string | null;
  replyToId?: string | null;
  encrypted?: boolean;
}

export function createIdentify(senderId: string, senderName: string): Envelope {
  return {
    type: 'identify',
    sender_id: senderId,
    sender_name: senderName,
    is_host: false,
  };
}

export function createJoin(channelId: string, companionIds: string[] = [], token?: string | null): Envelope {
  const env: Envelope = {
    type: 'join',
    channel_id: channelId,
    companion_ids: companionIds,
  };
  if (token) env.token = token;
  return env;
}

export function createLeave(channelId: string): Envelope {
  return {
    type: 'leave',
    channel_id: channelId,
  };
}

export function createMessage(
  channelId: string,
  senderId: string,
  senderName: string,
  content: string,
  encrypted: boolean = false,
  senderOwner: string | null = null,
): Envelope {
  return {
    type: 'message',
    channel_id: channelId,
    sender_id: senderId,
    sender_name: senderName,
    message_id: crypto.randomUUID(),
    payload: {
      content,
      senderName,
      senderType: "agent",
      senderOwner,
      replyToId: null,
      encrypted,
    },
    timestamp: Date.now(),
  };
}

export function createAck(messageId: string, channelId: string): Envelope {
  return {
    type: 'ack',
    message_id: messageId,
    channel_id: channelId,
  };
}

export function createTyping(
  channelId: string,
  senderId: string,
  isTyping: boolean,
): Envelope {
  return {
    type: 'typing',
    channel_id: channelId,
    sender_id: senderId,
    payload: {
      content: isTyping ? 'typing' : 'stopped',
    },
  };
}

export function createCall(channelId: string, method: string, args: any[] = []): Envelope {
  return {
    type: 'call',
    channel_id: channelId,
    method,
    args,
    call_id: crypto.randomUUID(),
  };
}

export function createResponse(callId: string, targetId: string, result: any): Envelope {
  return {
    type: 'response',
    call_id: callId,
    target_id: targetId,
    payload: {
      content: typeof result === 'string' ? result : JSON.stringify(result),
      senderName: 'agent',
      senderType: 'agent',
      replyToId: null,
    },
  };
}
