import { getTelegramInitData } from './telegram';

export type CatalogOption = { id: string; name: string };
export type ProductSummary = {
  id: string; name: string; brandName: string; imagePath: string | null;
  priceRub: number; hasPriceRange: boolean;
};
export type ProductPage = { items: ProductSummary[]; page: number; pageSize: number; hasMore: boolean };

export function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return execute<T>(url, 'GET', {}, undefined, signal, { canRepeat: true, serverTitles: false });
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
    public readonly code?: string, public readonly requestId?: string, public readonly kind: ApiErrorKind = 'http',
    /** For a version conflict: the record as it is on the server now (unvalidated JSON). */
    public readonly current?: unknown,
    /** For invalid input: the message for each field, by request path such as `variants[1].priceRub`. */
    public readonly fieldErrors?: Record<string, string>) { super(message); }

  /** Short reference to find the request in the server log (the full id is logged as request=...). */
  get reference(): string | undefined { return this.requestId?.slice(0, 8); }
}

export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.reference ? `${error.message} Код обращения: ${error.reference}.` : error.message;
}

type Problem = { title?: string; code?: string; requestId?: string; current?: unknown; fieldErrors?: Record<string, string> };

/** ValidationProblemDetails `errors`: keeps the first message of each well-formed path. */
function readFieldErrors(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [path, messages] of Object.entries(value).slice(0, 50)) {
    const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
    if (/^[A-Za-z][A-Za-z0-9]*(?:\[\d{1,3}\]|\.[A-Za-z][A-Za-z0-9]*)*$/.test(path) && path.length <= 100
      && typeof first === 'string' && first.length <= 300) result[path] = first;
  }
  return Object.keys(result).length ? result : undefined;
}

async function readProblem(response: Response): Promise<Problem> {
  const header = response.headers.get('X-Request-Id') ?? undefined;
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object') {
      const { title, code, requestId, current, errors } = payload as Record<string, unknown>;
      return {
        title: typeof title === 'string' && title.length <= 300 ? title : undefined,
        code: typeof code === 'string' && code.length <= 64 ? code : undefined,
        requestId: typeof requestId === 'string' && /^[0-9a-f]{8,64}$/.test(requestId) ? requestId : header,
        current: current && typeof current === 'object' ? current : undefined,
        fieldErrors: readFieldErrors(errors),
      };
    }
  }
  catch { /* A proxy may return HTML; keep the generic error. */ }
  return { requestId: header };
}

/** Login only registers the customer once, so like a read it is safe to repeat. */
const isSave = (url: string, method: string) => method !== 'GET' && url !== '/api/auth/telegram';

/** Limit for a whole operation, including retries: no request keeps the interface loading forever. */
export const READ_LIMIT_MS = 15_000;
export const SAVE_LIMIT_MS = 30_000;
const READ_RETRIES = 2, SAVE_RETRIES = 1, MAX_RETRY_AFTER_MS = 10_000;

/**
 * True when a save may or may not have been applied: no response, a timeout or a server error after sending.
 * A cancelled request on the client is not proof that the server rolled it back.
 */
export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network'
    || (error.status >= 500 && error.code !== 'secure_transport_unavailable'));
}

function noResponse(save: boolean, timedOut: boolean): ApiError {
  if (timedOut) return save
    ? new ApiError(0, 'Сервер не ответил вовремя. Изменения могли сохраниться: проверьте, прежде чем повторять.', 'outcome_unknown', undefined, 'network')
    : new ApiError(0, 'Сервер не ответил вовремя. Повторите попытку.', 'timeout', undefined, 'network');
  // fetch rejects only when no HTTP response arrived: offline, DNS, TLS, dropped connection.
  return save
    ? new ApiError(0, 'Связь прервалась до ответа сервера. Изменения могли сохраниться: обновите список и проверьте, прежде чем повторять.',
      'outcome_unknown', undefined, 'network')
    : new ApiError(0, 'Нет связи с сервером. Проверьте интернет и повторите.', 'network_error', undefined, 'network');
}

/** Aborts on the caller's signal or when the time limit runs out, and remembers which one happened. */
function withDeadline(outer: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward(); else outer?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal, timedOut: () => timedOut, started: Date.now(),
    dispose: () => { window.clearTimeout(timer); outer?.removeEventListener('abort', forward); },
  };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { window.clearTimeout(timer); reject(signal.reason); };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** 0.5 s, then 1.5 s, each ±30 %, so many clients do not retry at the same moment. */
const backoff = (retry: number) => 500 * 3 ** retry * (0.7 + Math.random() * 0.6);

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

type Policy = { canRepeat: boolean; serverTitles: boolean };

async function execute<T>(url: string, method: string, headers: Record<string, string>, body: string | undefined,
  outer: AbortSignal | undefined, policy: Policy): Promise<T> {
  const save = isSave(url, method);
  const limit = save ? SAVE_LIMIT_MS : READ_LIMIT_MS;
  const deadline = withDeadline(outer, limit);
  const fail = () => outer?.aborted ? outer.reason : noResponse(save, deadline.timedOut());
  try {
    for (let transportAttempt = 0, retry = 0; ;) {
      // Waits only when the delay still fits into the operation limit.
      const wait = async (milliseconds: number) => {
        if (Date.now() - deadline.started + milliseconds >= limit) return false;
        try { await pause(milliseconds, deadline.signal); } catch { throw fail(); }
        return true;
      };
      let response: Response;
      try { response = await fetch(url, { method, headers, body, signal: deadline.signal }); }
      catch (error) {
        if (outer?.aborted) throw error;
        if (!deadline.timedOut() && policy.canRepeat && retry < (save ? SAVE_RETRIES : READ_RETRIES) && await wait(backoff(retry++))) continue;
        throw fail();
      }
      if (response.ok) return await response.json() as T;
      const problem = await readProblem(response);
      // This marker is emitted only before authentication and before any business write, so it is always safe to repeat.
      if (response.status === 503 && problem.code === 'secure_transport_unavailable' && transportAttempt < 3
        && await wait(150 * 2 ** transportAttempt++)) continue;
      // Other temporary failures are repeated only when repeating cannot write twice:
      // reads, login, and saves carrying an Idempotency-Key. 401, 403 and other 4xx are final.
      if (policy.canRepeat && [502, 503, 504].includes(response.status) && problem.code !== 'secure_transport_unavailable'
        && retry < (save ? SAVE_RETRIES : READ_RETRIES)) {
        const delay = retryAfter(response);
        if ((delay === undefined || delay <= MAX_RETRY_AFTER_MS) && await wait(delay ?? backoff(retry))) { retry++; continue; }
      }
      if (!policy.serverTitles) throw new ApiError(response.status, undefined, problem.code, problem.requestId);
      if (response.status === 401) window.dispatchEvent(new Event('telegram-auth-expired'));
      if (response.status === 403) window.dispatchEvent(new Event('telegram-access-denied'));
      // Without a recognised server answer a failed write may still have been applied.
      const message = problem.title ?? (save && response.status >= 500
        ? 'Сервер не подтвердил сохранение. Обновите список и проверьте изменения, прежде чем повторять.' : undefined);
      throw new ApiError(response.status, message, problem.code, problem.requestId, 'http', problem.current, problem.fieldErrors);
    }
  } finally { deadline.dispose(); }
}

/**
 * `idempotencyKey`: the same key for every attempt of one save, so a repeat after a lost response does not write twice.
 * Only such saves are retried automatically; a save without a key is never repeated blindly.
 */
export async function authorizedJson<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal, idempotencyKey?: string): Promise<T> {
  const initData = getTelegramInitData();
  if (!initData) throw new ApiError(401, 'Нет данных входа Telegram. Откройте магазин из Telegram.', 'auth_missing');
  return execute<T>(url, method, {
    Authorization: `tma ${initData}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }, body === undefined ? undefined : JSON.stringify(body), signal,
  { canRepeat: !isSave(url, method) || idempotencyKey !== undefined, serverTitles: true });
}
