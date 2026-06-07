// IndexedDB-backed key/value store for large per-memo content (unsynced drafts +
// offline read cache). localStorage caps an origin at ~5MB, which a few 600KB memos
// blow through; IndexedDB is effectively unbounded.
//
// A synchronous in-memory mirror keeps the call sites simple (the app reads cached
// content synchronously for instant render): writes update the mirror immediately and
// persist to IDB in the background; hydrate() loads existing entries into the mirror at
// startup, before the app reads them. If IDB is unavailable (private mode, etc.) it
// degrades to an in-memory store for the session.
const DB_NAME = "nemo";
const STORE = "kv";
const mirror = new Map<string, string>();
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

// load all persisted entries into the in-memory mirror; call once before reads
export async function hydrate(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          mirror.set(String(cur.key), cur.value as string);
          cur.continue();
        } else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IDB unavailable — operate purely in-memory for this session
  }
}

function persist(op: (s: IDBObjectStore) => void): void {
  open()
    .then((db) => op(db.transaction(STORE, "readwrite").objectStore(STORE)))
    .catch(() => {});
}

export const kv = {
  get: (k: string): string | null => (mirror.has(k) ? mirror.get(k)! : null),
  set: (k: string, v: string): void => {
    mirror.set(k, v);
    persist((s) => s.put(v, k));
  },
  remove: (k: string): void => {
    mirror.delete(k);
    persist((s) => s.delete(k));
  },
};
