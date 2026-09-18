'use client';

import { useEffect, useId, useRef } from 'react';
import { shouldReloadForDomainRevision } from '@/lib/domain-sync';

const ENDPOINT = '/api/system/revision';
const CHANNEL = 'lifeos-domain-sync-v1';
const STORAGE_KEY = 'lifeos:domain-revision';

export default function LifeOSSyncProvider() {
  const known = useRef<number | null>(null);
  const tabId = useId();

  useEffect(() => {
    let active = true;
    const originalFetch = window.fetch.bind(window);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);

    const read = async () => {
      try {
        const response = await originalFetch(ENDPOINT, { cache: 'no-store' });
        if (!response.ok) return null;
        const payload = await response.json() as { revision?: number };
        return Number.isFinite(payload.revision) ? Number(payload.revision) : null;
      } catch {
        return null;
      }
    };
    const accept = (incoming: number, local: boolean) => {
      if (!active) return;
      if (known.current === null) {
        known.current = incoming;
        return;
      }
      if (local) {
        known.current = incoming;
        const message = { revision: incoming, origin: tabId };
        channel?.postMessage(message);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(message)); } catch { }
      } else if (shouldReloadForDomainRevision(known.current, incoming, false)) {
        known.current = incoming;
        window.location.reload();
      }
    };
    const reconcile = async (local = false) => {
      const revision = await read();
      if (revision !== null) accept(revision, local);
    };

    if (channel) {
      channel.onmessage = event => {
        const message = event.data as { revision?: number; origin?: string };
        if (message.origin !== tabId && Number.isFinite(message.revision)) accept(Number(message.revision), false);
      };
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const message = JSON.parse(event.newValue) as { revision?: number; origin?: string };
        if (message.origin !== tabId && Number.isFinite(message.revision)) accept(Number(message.revision), false);
      } catch { }
    };
    const onFocus = () => { void reconcile(); };
    const onVisible = () => document.visibilityState === 'visible' && void reconcile();
    const wrappedFetch: typeof window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (response.ok && !['GET', 'HEAD'].includes(method)) setTimeout(() => void reconcile(true), 0);
      return response;
    };

    window.fetch = wrappedFetch;
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(() => document.visibilityState === 'visible' && void reconcile(), 10_000);
    void reconcile();
    return () => {
      active = false;
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      window.clearInterval(poll);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      channel?.close();
    };
  }, [tabId]);

  return null;
}
