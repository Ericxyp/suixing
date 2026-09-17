import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ServerConfig } from '../config';

export type AmapProxyTransport = (
  input: string | URL,
  init?: RequestInit,
) => Promise<globalThis.Response>;

const DEFAULT_TIMEOUT_MS = 8_000;
const PROTECTED_QUERY_PARAMS = new Set([
  'jscode',
  'key',
  'sig',
  'callback',
  'url',
  'target',
]);
const UPSTREAM_URLS: Readonly<Record<string, string>> = Object.freeze({
  '/v4/map/styles': 'https://webapi.amap.com/v4/map/styles',
  '/v3/vectormap': 'https://fmap01.amap.com/v3/vectormap',
  '/v3/place/text': 'https://restapi.amap.com/v3/place/text',
  '/v3/direction/driving': 'https://restapi.amap.com/v3/direction/driving',
  '/v3/direction/walking': 'https://restapi.amap.com/v3/direction/walking',
});
const BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'application/x-protobuf',
  'application/vnd.mapbox-vector-tile',
];
const NOT_FOUND = {
  error: { code: 'NOT_FOUND', message: '地图服务路径不存在。' },
};
const INVALID_REQUEST = {
  error: { code: 'INVALID_REQUEST', message: '地图服务请求无效。' },
};
const PROVIDER_UNAVAILABLE = {
  error: { code: 'PROVIDER_UNAVAILABLE', message: '地图安全服务尚未配置。' },
};
const PROVIDER_ERROR = {
  error: { code: 'PROVIDER_ERROR', message: '地图服务暂时不可用，请稍后重试。' },
};

function safePath(path: string): string | null {
  let decoded = path;
  try {
    for (let index = 0; index < 2; index += 1) {
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    return null;
  }
  if (
    decoded !== path
    || decoded.includes('..')
    || decoded.includes('://')
    || decoded.includes('//')
    || decoded.includes('\\')
    || decoded.includes('\0')
  ) {
    return null;
  }
  return decoded;
}

function hasSafeQuery(request: Request): boolean {
  for (const [name, value] of Object.entries(request.query)) {
    if (PROTECTED_QUERY_PARAMS.has(name) || typeof value !== 'string') {
      return false;
    }
  }
  return true;
}

function appendQuery(
  request: Request,
  upstreamUrl: URL,
  securityCode: string,
): void {
  for (const [name, value] of Object.entries(request.query)) {
    if (typeof value === 'string') {
      upstreamUrl.searchParams.append(name, value);
    }
  }
  upstreamUrl.searchParams.set('jscode', securityCode);
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ['accept', 'accept-language']) {
    const value = request.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

function copyResponseHeaders(upstream: globalThis.Response, response: Response): void {
  const contentType = upstream.headers.get('content-type');
  const cacheControl = upstream.headers.get('cache-control');
  if (contentType) {
    response.set('content-type', contentType);
  }
  if (cacheControl) {
    response.set('cache-control', cacheControl);
  }
}

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes('application/json') || normalized.includes('+json');
}

function isExpectedBinaryContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    BINARY_CONTENT_TYPES.some((allowed) => normalized.includes(allowed))
    || normalized.startsWith('image/')
  );
}

async function forwardResponse(
  request: Request,
  upstream: globalThis.Response,
  response: Response,
): Promise<void> {
  if (!upstream.ok) {
    throw new Error('Upstream request failed.');
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const isJson = isJsonContentType(contentType);
  const isVectorBinary = request.path === '/v3/vectormap'
    && isExpectedBinaryContentType(contentType);
  if (!isJson && !isVectorBinary) {
    throw new Error('Unexpected upstream content.');
  }

  copyResponseHeaders(upstream, response);
  if (request.method === 'HEAD') {
    response.status(upstream.status).end();
    return;
  }
  if (isJson) {
    const payload = await upstream.json() as unknown;
    response.status(upstream.status).json(payload);
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  response.status(upstream.status).send(body);
}

export function createAmapProxyRouter(
  config: ServerConfig,
  transport?: AmapProxyTransport,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const router = Router();

  router.all('/*splat', async (request, response) => {
    const path = safePath(request.path);
    const upstream = path ? UPSTREAM_URLS[path] : undefined;
    if (!upstream) {
      response.status(404).json(NOT_FOUND);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.status(405).json(INVALID_REQUEST);
      return;
    }
    if (!hasSafeQuery(request)) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }

    const securityCode = config.amapSecurityJsCode?.trim();
    if (!securityCode || !transport) {
      response.status(503).json(PROVIDER_UNAVAILABLE);
      return;
    }

    const upstreamUrl = new URL(upstream);
    appendQuery(request, upstreamUrl, securityCode);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Upstream request timed out.'));
      }, timeoutMs);
    });

    try {
      const upstreamResponse = await Promise.race([
        transport(upstreamUrl, {
          method: request.method,
          headers: copyRequestHeaders(request),
          redirect: 'manual',
          signal: controller.signal,
        }),
        timeout,
      ]);
      await forwardResponse(request, upstreamResponse, response);
    } catch {
      if (!response.headersSent) {
        response.status(502).json(PROVIDER_ERROR);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });

  return router;
}
