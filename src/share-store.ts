// Simple in-memory share link store (edge-local). This is sufficient for
// early development. In production, migrate to Durable Objects or Xano table
// for global consistency.

export interface ShareRecord {
  xanoToken: string;
  userId: string;
  expiresAt: number; // epoch ms
}

const SHARE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const store = new Map<string, ShareRecord>();

export function generateToken(): string {
  return crypto.randomUUID();
}

/**
 * Persist a share record. If an Env with `SHARE_DO` binding is provided we store
 * it in the Durable Object; otherwise we fall back to in-memory Map (useful for
 * local dev and unit tests).
 */
export async function saveShare(token: string, xanoToken: string, userId: string, env?: { SHARE_DO?: FlexibleDurableObjectNamespace }) {
  if (env?.SHARE_DO) {
    const id = env.SHARE_DO.idFromName(token);
    await env.SHARE_DO.get(id).fetch("https://do/save", {
      method: "PUT",
      body: JSON.stringify({ xanoToken, userId }),
    });
    return;
  }
  store.set(token, {
    xanoToken,
    userId,
    expiresAt: Date.now() + SHARE_TTL_MS,
  });
}

/**
 * Retrieve a share record. If an Env with `SHARE_DO` binding is provided we fetch
 * it from the Durable Object; otherwise we fall back to in-memory Map (useful for
 * local dev and unit tests).
 */
import { FlexibleDurableObjectNamespace } from './types';

export async function getShare(token: string, env?: { SHARE_DO?: FlexibleDurableObjectNamespace }): Promise<ShareRecord | undefined> {
  if (env?.SHARE_DO) {
    const id = env.SHARE_DO.idFromName(token);
    const res = await env.SHARE_DO.get(id).fetch("https://do/get");
    if (res.status === 200) {
      return (await res.json()) as ShareRecord;
    }
    return undefined;
  }
  const rec = store.get(token);
  if (!rec) return undefined;
  if (rec.expiresAt < Date.now()) {
    store.delete(token);
    return undefined;
  }
  return rec;
}

/**
 * Revoke a share record. If an Env with `SHARE_DO` binding is provided we delete
 * it from the Durable Object; otherwise we fall back to in-memory Map (useful for
 * local dev and unit tests).
 */
export async function revokeShare(token: string, env?: { SHARE_DO?: FlexibleDurableObjectNamespace }) {
  if (env?.SHARE_DO) {
    const id = env.SHARE_DO.idFromName(token);
    await env.SHARE_DO.get(id).fetch("https://do/revoke", { method: "DELETE" });
    return;
  }
  store.delete(token);
}

// optional: housekeeping
export function purgeExpired() {
  const now = Date.now();
  for (const [token, rec] of store) {
    if (rec.expiresAt < now) store.delete(token);
  }
}
