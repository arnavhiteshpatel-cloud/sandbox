import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.ts';

let secret = getSetting<string | null>('server.secret', null);
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('server.secret', secret);
}

/** HMAC so proxy endpoints only fetch URLs this server handed out (prevents an open proxy / SSRF). */
export function sign(value: string) {
  return crypto.createHmac('sha256', secret!).update(value).digest('base64url').slice(0, 22);
}
export function checkSig(value: string, sig: string | undefined) {
  if (!sig) return false;
  const a = Buffer.from(sign(value));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
