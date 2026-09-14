import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliverOrder,
  isNetworkError,
  reportDeliveryFailure,
  uploadProofOfDelivery,
  type TourStop,
} from "@/lib/data/delivery";

/* ------------------------------------------------------------------ */
/*  Offline support for the livreur space (browser only): the last     */
/*  tour loaded (localStorage) and the outcomes recorded without       */
/*  network (IndexedDB outbox, photo included), replayed as soon as    */
/*  the connection comes back.                                         */
/* ------------------------------------------------------------------ */

export type OutboxItem = {
  id: string;
  userId: string;
  orgId: string;
  orderId: string;
  ref: string;
  kind: "deliver" | "fail";
  recipient?: string;
  note?: string;
  reason?: string;
  photo?: Blob | null;
  /** Set once the photo is uploaded, so a retry never uploads it twice. */
  podPath?: string | null;
  createdAt: number;
};

const DB_NAME = "autodecision-livreur";
const STORE = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function outboxAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function newOutboxId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listOutbox(userId: string): Promise<OutboxItem[]> {
  if (!outboxAvailable()) return [];
  const all = await withStore<OutboxItem[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxItem[]>);
  return all.filter((i) => i.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function putOutbox(item: OutboxItem): Promise<void> {
  await withStore("readwrite", (s) => s.put(item));
}

async function removeOutbox(id: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(id));
}

export type FlushReport = {
  sent: OutboxItem[];
  /** Refused by the server (reassigned, cancelled…): dropped from the outbox. */
  rejected: Array<{ item: OutboxItem; message: string }>;
  /** Delivered, but the photo was refused (format, size): confirmed without it. */
  photoDropped: OutboxItem[];
  /** Still waiting for the network. */
  remaining: number;
};

/** Replay the recorded outcomes in order; stops at the first network failure. */
export async function flushOutbox(supabase: SupabaseClient, userId: string): Promise<FlushReport> {
  const report: FlushReport = { sent: [], rejected: [], photoDropped: [], remaining: 0 };
  const items = await listOutbox(userId);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      if (item.kind === "deliver") {
        let podPath = item.podPath ?? null;
        if (item.photo && !podPath) {
          try {
            podPath = await uploadProofOfDelivery(supabase, item.orgId, item.orderId, item.photo);
            await putOutbox({ ...item, podPath });
          } catch (e) {
            if (isNetworkError(e)) throw e;
            report.photoDropped.push(item);
            podPath = null;
          }
        }
        await deliverOrder(supabase, {
          orderId: item.orderId,
          recipient: item.recipient,
          note: item.note,
          podPath,
        });
      } else {
        await reportDeliveryFailure(supabase, { orderId: item.orderId, reason: item.reason ?? "" });
      }
      await removeOutbox(item.id);
      report.sent.push(item);
    } catch (e) {
      if (isNetworkError(e)) {
        report.remaining = items.length - i;
        break;
      }
      await removeOutbox(item.id);
      report.rejected.push({ item, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/* ---- Last tour loaded ---- */

const cacheKey = (userId: string) => `livreur-tour:${userId}`;

export function saveTourCache(userId: string, stops: TourStop[]): void {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify({ savedAt: Date.now(), stops }));
  } catch {
    /* storage full or blocked: offline display simply won't have it */
  }
}

export function loadTourCache(userId: string): { savedAt: number; stops: TourStop[] } | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; stops?: unknown };
    if (!Array.isArray(parsed.stops)) return null;
    return { savedAt: Number(parsed.savedAt) || 0, stops: parsed.stops as TourStop[] };
  } catch {
    return null;
  }
}

export function clearTourCache(userId: string): void {
  try {
    localStorage.removeItem(cacheKey(userId));
  } catch {
    /* nothing to clear */
  }
}
