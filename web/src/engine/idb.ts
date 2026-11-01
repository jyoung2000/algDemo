/** IndexedDB backend for the Store (one object store per table). Used in the WebView; tests use MemoryBackend. */
import { openDB, type IDBPDatabase } from 'idb';
import type { Backend, Table } from './store';

const TABLES: Table[] = ['kv', 'seeds', 'feedback', 'impressions', 'cache', 'vectors', 'transfer'];

export async function openIdbBackend(name = 'airwave-discovery'): Promise<Backend> {
  const db: IDBPDatabase = await openDB(name, 1, {
    upgrade(d) {
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t);
    },
  });
  return {
    async load() {
      const out: Partial<Record<Table, [string, unknown][]>> = {};
      for (const t of TABLES) {
        const keys = await db.getAllKeys(t);
        const vals = await db.getAll(t);
        out[t] = keys.map((k, i) => [String(k), vals[i]]);
      }
      return out;
    },
    async put(t, k, v) {
      await db.put(t, v, k);
    },
    async del(t, k) {
      await db.delete(t, k);
    },
    async clear(t) {
      await db.clear(t);
    },
  };
}
