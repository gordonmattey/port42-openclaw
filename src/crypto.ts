/**
 * AES-256-GCM encryption/decryption matching Port42's ChannelCrypto.
 *
 * Wire format: base64(nonce[12] + ciphertext + tag[16])
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Payload } from './protocol';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(payload: Payload, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const nonce = randomBytes(NONCE_LENGTH);
  const cleartext = JSON.stringify(payload);

  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(cleartext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // nonce + ciphertext + tag
  const blob = Buffer.concat([nonce, encrypted, tag]);
  return blob.toString('base64');
}

export function decrypt(blob: string, keyBase64: string): Payload | null {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const data = Buffer.from(blob, 'base64');

    if (data.length < NONCE_LENGTH + TAG_LENGTH) {
      return null;
    }

    const nonce = data.subarray(0, NONCE_LENGTH);
    const tag = data.subarray(data.length - TAG_LENGTH);
    const ciphertext = data.subarray(NONCE_LENGTH, data.length - TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}
