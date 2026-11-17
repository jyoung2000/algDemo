import type { Store } from './store';
/** Skip older reads, share fresh answers within one refresh, and publish them for later visits. */
export function artistCache(store: Store | undefined, c: { refresh?: boolean; refreshToken?: string }): Store | undefined {
  if (!store || !c.refresh) return store;
  const freshKey = (key: string) => `${key}:refresh:${c.refreshToken}`;
  return {
    cacheGet: (key: string, stale?: boolean) => c.refreshToken && !stale ? store.cacheGet(freshKey(key)) : null,
    cachePut: async (key: string, kind: string, value: unknown, ttl: number) => {
      await store.cachePut(key, kind, value, ttl);
      if (c.refreshToken) await store.cachePut(freshKey(key), kind, value, ttl);
    },
  } as Store;
}
