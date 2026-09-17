export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type BffQueryValue = string | number | boolean | undefined;

export type BffClientErrorCode =
  | 'INVALID_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE'
  | 'TRIP_GENERATION_INCOMPLETE'
  | 'TRIP_GENERATION_TIMEOUT'
  | 'TRIP_CHANGE_INCOMPLETE';

export class BffClientError extends Error {
  constructor(
    readonly code: BffClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BffClientError';
  }
}

export interface BffClient {
  get(path: string, params?: Record<string, BffQueryValue>): Promise<unknown>;
  post(path: string, body?: Record<string, unknown>): Promise<unknown>;
}

const GET_ALLOWED_PATHS = new Set([
  '/api/places/search',
  '/api/routes',
]);
const POST_ALLOWED_PATHS = new Set([
  '/api/ai/requirements/extract',
  '/api/trips/generate',
  '/api/ai/trips/change/interpret',
  '/api/trips/change/apply',
  '/api/trips/meal-options',
  '/api/trips/meal/apply',
]);
const FORBIDDEN_QUERY_KEYS = new Set([
  'key',
  'jscode',
  'sig',
  'callback',
  'url',
  'target',
]);
const FORBIDDEN_BODY_KEYS = new Set([
  ...FORBIDDEN_QUERY_KEYS,
  'model',
  'prompt',
  'schema',
  'tools',
  'messages',
  'temperature',
  'max_tokens',
  'enable_thinking',
  'authorization',
  'apiKey',
  'baseUrl',
]);
const KNOWN_ERROR_CODES = new Set<BffClientErrorCode>([
  'INVALID_REQUEST',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_INVALID_REQUEST',
  'AI_PROVIDER_ERROR',
  'AI_INVALID_RESPONSE',
  'TRIP_GENERATION_INCOMPLETE',
  'TRIP_GENERATION_TIMEOUT',
  'TRIP_CHANGE_INCOMPLETE',
]);
const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_POST_TIMEOUT_MS = 70_000;
export const TRIP_CHANGE_APPLY_TIMEOUT_MS = 90_000;
const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const UNAVAILABLE_MESSAGE = '服务尚未配置。';
const PROVIDER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const NETWORK_ERROR_MESSAGE = '网络异常，请稍后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PLACE_DETAIL_PATH = /^\/api\/places\/[A-Za-z0-9_-]{1,64}$/;

function isSafeRelativeApiPath(path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '' || path !== path.trim()) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(path) || path.includes('://')) {
    return false;
  }
  if (path.startsWith('//') || path.startsWith('/_AMapService')) {
    return false;
  }
  if (
    path.includes('\\')
    || path.includes('..')
    || path.includes('//')
    || /[?#]/.test(path)
  ) {
    return false;
  }
  return true;
}

function isAllowedGetPath(path: string): boolean {
  return isSafeRelativeApiPath(path)
    && (GET_ALLOWED_PATHS.has(path) || PLACE_DETAIL_PATH.test(path));
}

function isAllowedPostPath(path: string): boolean {
  return isSafeRelativeApiPath(path) && POST_ALLOWED_PATHS.has(path);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => (
    FORBIDDEN_BODY_KEYS.has(key) || containsForbiddenKey(value[key])
  ));
}

function messageForCode(code: BffClientErrorCode): string {
  if (code === 'INVALID_REQUEST' || code === 'AI_INVALID_REQUEST') {
    return INVALID_REQUEST_MESSAGE;
  }
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'AI_PROVIDER_UNAVAILABLE') {
    return UNAVAILABLE_MESSAGE;
  }
  if (code === 'NETWORK_ERROR') {
    return NETWORK_ERROR_MESSAGE;
  }
  if (code === 'INVALID_RESPONSE' || code === 'AI_INVALID_RESPONSE') {
    return INVALID_RESPONSE_MESSAGE;
  }
  return PROVIDER_ERROR_MESSAGE;
}

function isSafeErrorMessage(message: string): boolean {
  return (
    message.trim() !== ''
    && message.length <= 200
    && !message.includes('://')
    && !message.includes('http')
    && !message.includes('\\')
  );
}

function readBffError(payload: unknown): BffClientError | null {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null;
  }
  const { code, message } = payload.error;
  if (typeof code !== 'string' || !KNOWN_ERROR_CODES.has(code as BffClientErrorCode)) {
    return null;
  }
  const mappedCode = code as BffClientErrorCode;
  if (typeof message !== 'string' || !isSafeErrorMessage(message)) {
    return new BffClientError(mappedCode, messageForCode(mappedCode));
  }
  return new BffClientError(mappedCode, message);
}

export class BffHttpClient implements BffClient {
  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly postTimeoutMs = DEFAULT_POST_TIMEOUT_MS,
  ) {}

  async get(
    path: string,
    params: Record<string, BffQueryValue> = {},
  ): Promise<unknown> {
    if (!isAllowedGetPath(path)) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }

    for (const name of Object.keys(params)) {
      if (FORBIDDEN_QUERY_KEYS.has(name)) {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
    }

    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        search.set(name, String(value));
      }
    }
    const query = search.toString();
    const requestPath = query === '' ? path : `${path}?${query}`;
    return this.send(requestPath, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }, this.timeoutMs);
  }

  async post(
    path: string,
    body: Record<string, unknown> = {},
    timeoutMs = this.postTimeoutMs,
  ): Promise<unknown> {
    if (!isAllowedPostPath(path) || !isRecord(body)) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }

    for (const name of Object.keys(body)) {
      if (FORBIDDEN_BODY_KEYS.has(name)) {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
    }

    if (path === '/api/ai/requirements/extract') {
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'input' || typeof body.input !== 'string') {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
    }

    if (path === '/api/trips/generate') {
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'requirement' || !isRecord(body.requirement)) {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
      for (const name of Object.keys(body.requirement)) {
        if (FORBIDDEN_BODY_KEYS.has(name)) {
          throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
        }
      }
    }

    if (path === '/api/ai/trips/change/interpret') {
      const keys = Object.keys(body);
      if (
        keys.length !== 2
        || typeof body.input !== 'string'
        || !isRecord(body.context)
        || containsForbiddenKey(body)
      ) {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
    }

    if (path === '/api/trips/change/apply') {
      const keys = Object.keys(body);
      if (
        keys.length !== 3
        || !isRecord(body.trip)
        || !Array.isArray(body.places)
        || !isRecord(body.operation)
        || containsForbiddenKey(body)
      ) {
        throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      }
    }

    return this.send(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  private async send(
    requestPath: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(requestPath, {
          ...init,
          signal: controller.signal,
        });
      } catch {
        throw new BffClientError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new BffClientError(
          response.ok ? 'INVALID_RESPONSE' : 'PROVIDER_ERROR',
          response.ok ? INVALID_RESPONSE_MESSAGE : PROVIDER_ERROR_MESSAGE,
        );
      }

      if (!response.ok) {
        throw readBffError(payload)
          ?? new BffClientError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      }

      if (!isRecord(payload) || !('data' in payload) || !isRecord(payload.data)) {
        throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
      }

      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}
