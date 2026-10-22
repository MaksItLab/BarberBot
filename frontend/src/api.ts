import { getTelegramInitData } from './telegram';

export type CatalogOption = { id: string; name: string };
export type ProductSummary = {
  id: string; name: string; brandName: string; imagePath: string | null;
  priceRub: number; hasPriceRange: boolean;
};
export type ProductPage = { items: ProductSummary[]; page: number; pageSize: number; hasMore: boolean };

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new ApiError(response.status);
  return await response.json() as T;
}

export const formatPrice = (value: number) => new Intl.NumberFormat('ru-RU', {
  style: 'currency', currency: 'RUB', maximumFractionDigits: 2,
}).format(value);

export function localImage(path: string | null): string | undefined {
  return path && /^\/images\/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp|avif)$/i.test(path) ? path : undefined;
}

export type ProductVariant = { id: string; volume: string | null; size: string | null; shade: string | null; priceRub: number };
export type ProductDetails = {
  id: string; name: string; description: string; brandName: string; brandDescription: string | null;
  typeName: string; imagePath: string | null; variants: ProductVariant[];
};

export class ApiError extends Error {
  constructor(public readonly status: number, message = 'Не удалось выполнить действие. Попробуйте ещё раз.') { super(message); }
}

function waitForTransportRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { window.clearTimeout(timer); reject(signal?.reason); };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function authorizedJson<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const initData = getTelegramInitData();
  if (!initData) throw new ApiError(401);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { method, signal,
      headers: { Authorization: `tma ${initData}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return await response.json() as T;
    let problem: { title?: unknown; code?: unknown } = {};
    if ([400, 404, 409, 503].includes(response.status)) {
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === 'object') problem = payload as typeof problem;
      }
      catch { /* A proxy may return HTML; keep the generic error. */ }
    }
    // This marker is emitted only before authentication and before any business write.
    // Never automatically repeat a write with an unknown outcome (network errors/other 5xx).
    if (response.status === 503 && problem.code === 'secure_transport_unavailable' && attempt < 3) {
      await waitForTransportRetry(150 * 2 ** attempt, signal);
      continue;
    }
    if (response.status === 401) window.dispatchEvent(new Event('telegram-auth-expired'));
    if (response.status === 403) window.dispatchEvent(new Event('telegram-access-denied'));
    const message = typeof problem.title === 'string' && problem.title.length <= 300 ? problem.title : undefined;
    throw new ApiError(response.status, message);
  }
}
