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
export async function saveShare(token: string, xanoToken: string, userId: string, env?: { SHARE_DO?: DurableObjectNamespace }) {
  // For development without Durable Objects, use in-memory store
  if (!env?.SHARE_DO) {
    console.log(`[saveShare] Storing share token ${token} in memory`);
    store.set(token, {
      xanoToken,
      userId,
      expiresAt: Date.now() + SHARE_TTL_MS,
    });
    return;
  }
  
  // For production with Durable Objects
  console.log(`[saveShare] Storing share token ${token} in Durable Object`);
  try {
    const id = env.SHARE_DO.idFromName(token);
    const stub = env.SHARE_DO.get(id);
    const response = await stub.fetch("https://do/save", {
      method: "PUT",
      body: JSON.stringify({ xanoToken, userId }),
    });
    
    if (!response.ok) {
      console.error(`[saveShare] Failed to store share token: ${response.status} ${response.statusText}`);
    } else {
      console.log(`[saveShare] Successfully stored share token in Durable Object`);
    }
  } catch (error) {
    console.error(`[saveShare] Error storing share token:`, error);
    // Fallback to memory store if Durable Object fails
    store.set(token, {
      xanoToken,
      userId,
      expiresAt: Date.now() + SHARE_TTL_MS,
    });
  }
}

/**
 * Retrieve a share record. If an Env with `SHARE_DO` binding is provided we fetch
 * it from the Durable Object; otherwise we fall back to in-memory Map (useful for
 * local dev and unit tests).
 */
export async function getShare(token: string, env?: { SHARE_DO?: DurableObjectNamespace }): Promise<ShareRecord | undefined> {
  console.log(`[getShare] Looking up share token: ${token}`);

  // First try in-memory store (works in all environments)
  const memoryRecord = store.get(token);
  if (memoryRecord) {
    console.log(`[getShare] Found share token in memory store`);
    if (memoryRecord.expiresAt < Date.now()) {
      console.log(`[getShare] Share token expired, removing from memory`);
      store.delete(token);
      return undefined;
    }
    return memoryRecord;
  }
  
  // If not in memory and we have Durable Objects, try there
  if (env?.SHARE_DO) {
    console.log(`[getShare] Looking up share token in Durable Object`);
    try {
      const id = env.SHARE_DO.idFromName(token);
      const stub = env.SHARE_DO.get(id);
      const res = await stub.fetch("https://do/get");
      
      if (res.status === 200) {
        const shareRecord = await res.json() as ShareRecord;
        console.log(`[getShare] Found share token in Durable Object, userId: ${shareRecord.userId}`);
        // Also store in memory for faster retrieval next time
        store.set(token, shareRecord);
        return shareRecord;
      } else {
        console.log(`[getShare] Share token not found in Durable Object: ${res.status}`);
      }
    } catch (error) {
      console.error(`[getShare] Error retrieving share token from Durable Object:`, error);
    }
  }

  console.log(`[getShare] Share token not found`);
  return undefined;
}

/**
 * Revoke a share record. If an Env with `SHARE_DO` binding is provided we delete
 * it from the Durable Object; otherwise we fall back to in-memory Map (useful for
 * local dev and unit tests).
 */
export async function revokeShare(token: string, env?: { SHARE_DO?: DurableObjectNamespace }) {
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
