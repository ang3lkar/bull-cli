import { useCallback, useSyncExternalStore } from 'react';
import type { DashboardSnapshot, DashboardStore } from '../../core/store.js';

/**
 * Subscribes a component to a `DashboardStore`, per React's
 * `useSyncExternalStore` contract. `subscribe`/`getSnapshot` are wrapped in
 * `useCallback` (stable as long as `store` itself doesn't change) rather than
 * passed as bare method references — `DashboardStore#subscribe` and
 * `#getSnapshot` are plain prototype methods, so `store.subscribe` alone
 * would lose its `this` binding once handed off to React.
 */
export function useStore(store: DashboardStore): DashboardSnapshot {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
