import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import type { AmapProxyTransport } from '../server/routes/amap-proxy';

const SECURITY_CODE = 'test-security-code-private';
const noSecurityConfig: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  amapSecurityJsCode: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};
const configuredSecurityConfig: ServerConfig = {
  ...noSecurityConfig,
  amapSecurityJsCode: SECURITY_CODE,
  hasAmapSecurityJsCode: true,
};

interface TransportCall {
  url: URL;
  init?: RequestInit;
}

function jsonTransport(
  calls: TransportCall[],
  payload: unknown = { status: '1', data: 'safe-map-data' },
): AmapProxyTransport {
  return async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60',
      },
    });
  };
}

async function request(
  path: string,
  options: {
    config?: ServerConfig;
    transport?: AmapProxyTransport;
    timeoutMs?: number;
    method?: string;
    headers?: HeadersInit;
  } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const server = createServer(createApp(options.config ?? noSecurityConfig, {
    amapProxyTransport: options.transport,
    amapProxyTimeoutMs: options.timeoutMs,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
    });
    return {
      status: response.status,
      text: await response.text(),
      headers: response.headers,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function assertNoSensitiveLeak(text: string): void {
  for (const value of [
    SECURITY_CODE,
    'webapi.amap.com',
    'fmap01.amap.com',
    'restapi.amap.com',
    'UPSTREAM_PRIVATE_BODY',
    'UPSTREAM_NETWORK_DETAIL',
    'evil.example.com',
  ]) {
    assert.equal(text.includes(value), false);
  }
}

const notFound = {
  error: { code: 'NOT_FOUND', message: '地图服务路径不存在。' },
};
const invalidRequest = {
  error: { code: 'INVALID_REQUEST', message: '地图服务请求无效。' },
};
const providerError = {
  error: {
    code: 'PROVIDER_ERROR',
    message: '地图服务暂时不可用，请稍后重试。',
  },
};

test('rejects paths outside the fixed whitelist without calling transport', async () => {
  const calls: TransportCall[] = [];
  const result = await request('/_AMapService/v3/unknown', {
    config: configuredSecurityConfig,
    transport: jsonTransport(calls),
  });

  assert.equal(result.status, 404);
  assert.deepEqual(parseJson(result.text), notFound);
  assert.equal(calls.length, 0);
});

test('rejects traversal, encoded, absolute, and double-slash paths', async () => {
  const calls: TransportCall[] = [];
  const suspiciousPaths = [
    '/_AMapService/../secret',
    '/_AMapService/%2E%2E%2Fsecret',
    '/_AMapService/%252E%252E%252Fsecret',
    '/_AMapService/https://evil.example.com/v3/place/text',
    '/_AMapService//v3/place/text',
    '/_AMapService/%76%33/place/text',
  ];

  for (const path of suspiciousPaths) {
    const result = await request(path, {
      config: configuredSecurityConfig,
      transport: jsonTransport(calls),
    });
    assert.equal(result.status, 404);
    assertNoSensitiveLeak(result.text);
  }
  assert.equal(calls.length, 0);
});

test('rejects protected query parameters before forwarding', async () => {
  const calls: TransportCall[] = [];
  for (const name of ['jscode', 'key', 'sig', 'callback', 'url', 'target']) {
    const result = await request(
      `/_AMapService/v4/map/styles?${name}=PRIVATE_CLIENT_VALUE`,
      {
        config: configuredSecurityConfig,
        transport: jsonTransport(calls),
      },
    );
    assert.equal(result.status, 400);
    assert.deepEqual(parseJson(result.text), invalidRequest);
    assert.equal(result.text.includes('PRIVATE_CLIENT_VALUE'), false);
  }
  assert.equal(calls.length, 0);
});

test('rejects POST, PUT, and DELETE with JSON 405 responses', async () => {
  const calls: TransportCall[] = [];
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const result = await request('/_AMapService/v4/map/styles', {
      config: configuredSecurityConfig,
      transport: jsonTransport(calls),
      method,
    });
    assert.equal(result.status, 405);
    assert.deepEqual(parseJson(result.text), invalidRequest);
  }
  assert.equal(calls.length, 0);
});

test('returns 503 for a whitelisted path without a security code', async () => {
  const calls: TransportCall[] = [];
  const result = await request('/_AMapService/v4/map/styles', {
    transport: jsonTransport(calls),
  });

  assert.equal(result.status, 503);
  assert.deepEqual(parseJson(result.text), {
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: '地图安全服务尚未配置。',
    },
  });
  assert.equal(calls.length, 0);
});

test('maps every fixed path to its fixed upstream and injects jscode once', async () => {
  const mappings = [
    ['/v4/map/styles', 'https://webapi.amap.com/v4/map/styles'],
    ['/v3/vectormap', 'https://fmap01.amap.com/v3/vectormap'],
    ['/v3/place/text', 'https://restapi.amap.com/v3/place/text'],
    ['/v3/direction/driving', 'https://restapi.amap.com/v3/direction/driving'],
    ['/v3/direction/walking', 'https://restapi.amap.com/v3/direction/walking'],
  ] as const;

  for (const [localPath, upstream] of mappings) {
    const calls: TransportCall[] = [];
    const result = await request(
      `/_AMapService${localPath}?lang=zh_cn&zoom=10`,
      {
        config: configuredSecurityConfig,
        transport: jsonTransport(calls),
        headers: {
          accept: 'application/json',
          authorization: 'Bearer PRIVATE_AUTH',
          cookie: 'PRIVATE_COOKIE=1',
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      `${calls[0].url.origin}${calls[0].url.pathname}`,
      upstream,
    );
    assert.equal(calls[0].url.searchParams.get('lang'), 'zh_cn');
    assert.equal(calls[0].url.searchParams.get('zoom'), '10');
    assert.deepEqual(calls[0].url.searchParams.getAll('jscode'), [SECURITY_CODE]);
    assert.equal(calls[0].url.searchParams.has('key'), false);
    assert.equal(calls[0].init?.redirect, 'manual');
    const forwardedHeaders = new Headers(calls[0].init?.headers);
    assert.equal(forwardedHeaders.get('accept'), 'application/json');
    assert.equal(forwardedHeaders.has('authorization'), false);
    assert.equal(forwardedHeaders.has('cookie'), false);
    assert.equal(forwardedHeaders.has('host'), false);
    assert.deepEqual(parseJson(result.text), {
      status: '1',
      data: 'safe-map-data',
    });
    assert.equal(
      result.headers.get('cache-control'),
      'public, max-age=60',
    );
    assertNoSensitiveLeak(result.text);
  }
});

test('allows HEAD and forwards no response body', async () => {
  const calls: TransportCall[] = [];
  const result = await request('/_AMapService/v4/map/styles', {
    config: configuredSecurityConfig,
    transport: jsonTransport(calls),
    method: 'HEAD',
  });

  assert.equal(result.status, 200);
  assert.equal(result.text, '');
  assert.equal(calls[0].init?.method, 'HEAD');
});

test('returns safe 502 errors for network, non-2xx, and unexpected content', async () => {
  const transports: AmapProxyTransport[] = [
    async () => {
      throw new Error('UPSTREAM_NETWORK_DETAIL restapi.amap.com');
    },
    async () => new Response('UPSTREAM_PRIVATE_BODY', { status: 429 }),
    async () => new Response('UPSTREAM_PRIVATE_BODY', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    async () => new Response('{invalid json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];

  for (const transport of transports) {
    const result = await request('/_AMapService/v4/map/styles', {
      config: configuredSecurityConfig,
      transport,
    });
    assert.equal(result.status, 502);
    assert.deepEqual(parseJson(result.text), providerError);
    assertNoSensitiveLeak(result.text);
  }
});

test('aborts timed-out transport and returns a safe 502', async () => {
  let receivedSignal: AbortSignal | undefined;
  const transport: AmapProxyTransport = (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      receivedSignal?.addEventListener(
        'abort',
        () => reject(new Error('UPSTREAM_NETWORK_DETAIL')),
        { once: true },
      );
    });
  };

  const result = await request('/_AMapService/v4/map/styles', {
    config: configuredSecurityConfig,
    transport,
    timeoutMs: 5,
  });

  assert.equal(result.status, 502);
  assert.deepEqual(parseJson(result.text), providerError);
  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);
  assertNoSensitiveLeak(result.text);
});

test('does not follow upstream redirects', async () => {
  const calls: TransportCall[] = [];
  const transport: AmapProxyTransport = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example.com/private' },
    });
  };

  const result = await request('/_AMapService/v4/map/styles', {
    config: configuredSecurityConfig,
    transport,
  });

  assert.equal(result.status, 502);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.deepEqual(parseJson(result.text), providerError);
  assertNoSensitiveLeak(result.text);
});
