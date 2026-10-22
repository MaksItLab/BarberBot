import { getTelegramInitData } from './telegram';

export type CatalogOption = { id: string; name: string };
export type ProductSummary = {
  id: string; name: string; brandName: string; imagePath: string | null;
  priceRub: number; hasPriceRange: boolean;
};
export type ProductPage = { items: ProductSummary[]; page: number; pageSize: number; hasMore: boolean };

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await send(url, { signal }, 'GET');
  if (!response.ok) {
    const problem = await readProblem(response);
    throw new ApiError(response.status, undefined, problem.code, problem.requestId);
  }
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

/** `network`: no response from the server at all, so a write may or may not have been applied. */
export type ApiErrorKind = 'http' | 'network';

export class ApiError extends Error {
  constructor(public readonly status: number, message = 'Не удалось выполнить действие. Попробуйте ещё раз.',
    public readonly code?: string, public readonly requestId?: string, public readonly kind: ApiErrorKind = 'http') { super(message); }

  /** Short reference to find the request in the server log (the full id is logged as request=...). */
  get reference(): string | undefined { return this.requestId?.slice(0, 8); }
}

export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.reference ? `${error.message} Код обращения: ${error.reference}.` : error.message;
}

type Problem = { title?: string; code?: string; requestId?: string };

async function readProblem(response: Response): Promise<Problem> {
  const header = response.headers.get('X-Request-Id') ?? undefined;
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object') {
      const { title, code, requestId } = payload as Record<string, unknown>;
      return {
        title: typeof title === 'string' && title.length <= 300 ? title : undefined,
        code: typeof code === 'string' && code.length <= 64 ? code : undefined,
        requestId: typeof requestId === 'string' && /^[0-9a-f]{8,64}$/.test(requestId) ? requestId : header,
      };
    }
  }
  catch { /* A proxy may return HTML; keep the generic error. */ }
  return { requestId: header };
}

/** Login only registers the customer once, so like a read it is safe to repeat. */
const isSave = (url: string, method: string) => method !== 'GET' && url !== '/api/auth/telegram';

async function send(url: string, init: RequestInit, method: string): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    // fetch rejects only when no HTTP response arrived: offline, DNS, TLS, dropped connection.
    throw !isSave(url, method)
      ? new ApiError(0, 'Нет связи с сервером. Проверьте интернет и повторите.', 'network_error', undefined, 'network')
      : new ApiError(0, 'Связь прервалась до ответа сервера. Изменения могли сохраниться: обновите список и проверьте, прежде чем повторять.',
        'outcome_unknown', undefined, 'network');
  }
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
  if (!initData) throw new ApiError(401, 'Нет данных входа Telegram. Откройте магазин из Telegram.', 'auth_missing');
  for (let attempt = 0; ; attempt++) {
    const response = await send(url, { method, signal,
      headers: { Authorization: `tma ${initData}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, method);
    if (response.ok) return await response.json() as T;
    const problem = await readProblem(response);
    // This marker is emitted only before authentication and before any business write.
    // Never automatically repeat a write with an unknown outcome (network errors/other 5xx).
    if (response.status === 503 && problem.code === 'secure_transport_unavailable' && attempt < 3) {
      await waitForTransportRetry(150 * 2 ** attempt, signal);
      continue;
    }
    if (response.status === 401) window.dispatchEvent(new Event('telegram-auth-expired'));
    if (response.status === 403) window.dispatchEvent(new Event('telegram-access-denied'));
    // Without a recognised server answer a failed write may still have been applied.
    const message = problem.title ?? (isSave(url, method) && response.status >= 500
      ? 'Сервер не подтвердил сохранение. Обновите список и проверьте изменения, прежде чем повторять.' : undefined);
    throw new ApiError(response.status, message, problem.code, problem.requestId);
  }
}
