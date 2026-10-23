import { getJson } from './api';
import type { CatalogOption } from './api';

type Shared = { promise: Promise<unknown>; controller: AbortController; waiting: number };
const inFlight = new Map<string, Shared>();

const aborted = (signal?: AbortSignal) => signal?.reason ?? new DOMException('Aborted', 'AbortError');

/**
 * U01: identical public catalog GETs in flight share one request. A caller that leaves stops waiting;
 * the request itself is aborted only when nobody waits for it any more.
 */
export function sharedGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  let shared = inFlight.get(url);
  if (!shared) {
    const controller = new AbortController();
    const created: Shared = { controller, waiting: 0, promise: getJson<T>(url, controller.signal) };
    created.promise.then(() => {}, () => {}).finally(() => { if (inFlight.get(url) === created) inFlight.delete(url); });
    inFlight.set(url, created);
    shared = created;
  }
  const entry = shared;
  entry.waiting++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true; entry.waiting--;
      signal?.removeEventListener('abort', leave);
      return true;
    };
    function leave() {
      if (!settle()) return;
      // A caller that re-subscribes at once (a re-run effect) joins the same request instead of a new one.
      if (entry.waiting === 0) setTimeout(() => {
        if (entry.waiting > 0) return;
        entry.controller.abort();
        if (inFlight.get(url) === entry) inFlight.delete(url);
      });
      reject(aborted(signal));
    }
    signal?.addEventListener('abort', leave, { once: true });
    entry.promise.then(value => { if (settle()) resolve(value as T); }, error => { if (settle()) reject(error); });
  });
}

export type CatalogReferences = { brands: CatalogOption[]; types: CatalogOption[] };
let references: CatalogReferences | undefined;
let generation = 0;

/** Brands and types, loaded once per app session: a filter change only asks for products. */
export async function loadReferences(signal?: AbortSignal): Promise<CatalogReferences> {
  if (references) return references;
  const started = generation;
  const [brands, types] = await Promise.all([
    sharedGet<CatalogOption[]>('/api/catalog/brands', signal),
    sharedGet<CatalogOption[]>('/api/catalog/types', signal),
  ]);
  const loaded = { brands, types };
  if (started === generation) references = loaded; // an admin save meanwhile makes this answer stale for later views
  return loaded;
}

const listeners = new Set<() => void>();

/** Calls back after an admin save changed the catalog. Returns the undo. */
export function onCatalogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** After an admin save: references load again and the catalog view starts afresh. */
export function invalidateCatalog() {
  references = undefined; generation++;
  listeners.forEach(listener => listener());
}
