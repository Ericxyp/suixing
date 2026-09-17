export type AmapQueryValue = string | number | boolean | undefined;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AmapHttpClient {
  get<T>(
    path: string,
    params: Record<string, AmapQueryValue>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

export interface AmapHttpClientFactory {
  create(apiKey: string): AmapHttpClient;
}

export class AmapProviderError extends Error {
  constructor(
    readonly code: 'PROVIDER_UNAVAILABLE' | 'INVALID_REQUEST' | 'PROVIDER_ERROR',
    message: string,
  ) {
    super(message);
  }
}

const AMAP_WEB_SERVICE_ORIGIN = 'https://restapi.amap.com';
const ALLOWED_PATHS = new Set([
  '/v3/place/text',
  '/v3/place/detail',
  '/v3/direction/driving',
  '/v3/direction/walking',
]);
const DEFAULT_TIMEOUT_MS = 8_000;
const FORBIDDEN_PARAMS = new Set(['key', 'jscode', 'sig', 'callback']);
const PROVIDER_UNAVAILABLE_MESSAGE = '地点服务暂时不可用，请稍后重试。';

export class AmapWebServiceHttpClient implements AmapHttpClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async get<T>(
    path: string,
    params: Record<string, AmapQueryValue>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    if (this.apiKey.trim() === '') {
      throw new AmapProviderError('PROVIDER_UNAVAILABLE', '地点服务尚未配置。');
    }

    if (!ALLOWED_PATHS.has(path)) {
      throw new AmapProviderError('INVALID_REQUEST', '不支持的高德服务路径。');
    }

    for (const name of Object.keys(params)) {
      if (FORBIDDEN_PARAMS.has(name)) {
        throw new AmapProviderError(
          'INVALID_REQUEST',
          '不允许传入受保护的高德请求参数。',
        );
      }
    }

    const url = new URL(path, AMAP_WEB_SERVICE_ORIGIN);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    url.searchParams.set('key', this.apiKey.trim());

    if (options?.signal?.aborted) {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_UNAVAILABLE_MESSAGE);
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal });
      } catch {
        throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_UNAVAILABLE_MESSAGE);
      }

      if (!response.ok) {
        throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_UNAVAILABLE_MESSAGE);
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_UNAVAILABLE_MESSAGE);
      }
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onParentAbort);
    }
  }
}
