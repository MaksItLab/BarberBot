import type { AdminProduct } from './AdminProducts';
import type { TelegramDeviceStorage } from './telegram';

/**
 * R06: unsaved product input kept on this device only. Never contains initData, the role or any token:
 * the key names the account from the server's login answer, the value holds form fields only.
 */
export type DraftVariantFields = { id?: string; volume: string; size: string; shade: string; price: string; isVisible: boolean };
export type DraftFields = {
  name: string; description: string; brandId: string; typeId: string; imagePath: string; visible: boolean;
  variants: DraftVariantFields[];
};
export type ProductDraft = {
  savedAt: number;
  /** The product version these changes apply to; null for a new product. */
  base: AdminProduct | null;
  /** The form's Idempotency-Key, so a restored form repeats the same save instead of a new one. */
  saveKey: string;
  /** A save was sent and its outcome was not confirmed: check it before anything else (R04). */
  unconfirmed: boolean;
  fields: DraftFields;
};

export type DraftStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const PREFIX = 'draft:v1:';
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const draftKey = (telegramId: string, productId: string | null) => `${PREFIX}${telegramId}:${productId ?? 'new'}`;

function deviceStore(storage: TelegramDeviceStorage): DraftStore {
  const call = <T,>(run: (callback: (error: string | null, value?: T) => void) => void) => new Promise<T | undefined>((resolve, reject) => {
    try { run((error, value) => error ? reject(new Error(error)) : resolve(value)); } catch (error) { reject(error); }
  });
  return {
    get: async key => (await call<string>(callback => storage.getItem(key, callback))) || null,
    set: async (key, value) => { if (await call<boolean>(callback => storage.setItem(key, value, callback)) === false) throw new Error('not stored'); },
    remove: async key => { await call<boolean>(callback => storage.removeItem(key, callback)); },
  };
}

function localStore(): DraftStore | null {
  try {
    const storage = window.localStorage;
    storage.setItem(`${PREFIX}probe`, '1'); storage.removeItem(`${PREFIX}probe`);
    // Without key listing in DeviceStorage expired drafts are dropped when read; here they can also be pruned.
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX) && !parseDraft(storage.getItem(key), Date.now())) storage.removeItem(key);
    }
    return {
      get: async key => storage.getItem(key),
      set: async (key, value) => storage.setItem(key, value),
      remove: async key => storage.removeItem(key),
    };
  } catch { return null; } // Disabled or cleared storage in the WebView: the form warns instead.
}

/** Telegram DeviceStorage where the client supports it, else localStorage, else null (no draft on this device). */
export function openDraftStore(): DraftStore | null {
  const webApp = window.Telegram?.WebApp;
  try {
    if (webApp?.DeviceStorage && webApp.isVersionAtLeast?.('9.0')) return deviceStore(webApp.DeviceStorage);
  } catch { /* fall back to the browser storage */ }
  return localStore();
}

const isText = (value: unknown) => typeof value === 'string' && value.length <= 12_000;

function isVariant(value: unknown): value is DraftVariantFields {
  const row = value as Record<string, unknown> | null;
  return !!row && typeof row === 'object' && (row.id === undefined || typeof row.id === 'string')
    && ['volume', 'size', 'shade', 'price'].every(field => isText(row[field])) && typeof row.isVisible === 'boolean';
}

/** Storage content is untrusted: a damaged, foreign-format or expired value is treated as no draft. */
export function parseDraft(text: string | null, now: number): ProductDraft | null {
  if (!text) return null;
  try {
    const draft = JSON.parse(text) as Partial<ProductDraft> & { v?: number };
    const fields = draft.fields as Record<string, unknown> | undefined;
    const base = draft.base as Partial<AdminProduct> | null | undefined;
    if (draft.v !== 1 || typeof draft.savedAt !== 'number' || now - draft.savedAt > DRAFT_TTL_MS || draft.savedAt > now + 60_000) return null;
    if (typeof draft.saveKey !== 'string' || !/^[0-9a-f-]{36}$/.test(draft.saveKey) || typeof draft.unconfirmed !== 'boolean') return null;
    if (base !== null && (typeof base?.id !== 'string' || typeof base.version !== 'string' || !Array.isArray(base.variants))) return null;
    if (!fields || !['name', 'description', 'brandId', 'typeId', 'imagePath'].every(field => isText(fields[field]))
      || typeof fields.visible !== 'boolean' || !Array.isArray(fields.variants) || fields.variants.length > 100
      || !fields.variants.every(isVariant)) return null;
    return { savedAt: draft.savedAt, base: base as AdminProduct | null, saveKey: draft.saveKey, unconfirmed: draft.unconfirmed, fields: fields as DraftFields };
  } catch { return null; }
}

export async function readDraft(store: DraftStore, key: string): Promise<ProductDraft | null> {
  const text = await store.get(key);
  const draft = parseDraft(text, Date.now());
  if (text && !draft) await store.remove(key);
  return draft;
}

export const writeDraft = (store: DraftStore, key: string, draft: ProductDraft) =>
  store.set(key, JSON.stringify({ v: 1, ...draft }));

/** "14:05" for today, otherwise "21.10, 14:05". */
export function draftTime(savedAt: number): string {
  const at = new Date(savedAt);
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? time
    : `${at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`;
}
