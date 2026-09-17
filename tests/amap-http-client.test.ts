import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmapProviderError,
  AmapWebServiceHttpClient,
  type FetchLike,
} from '../server/services/amap-http-client';

const TEST_KEY = 'test-amap-web-service-key';
const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';

function createCapturingFetch(capturedUrls: URL[]): FetchLike {
  return async (input) => {
    capturedUrls.push(new URL(String(input)));
    return new Response(JSON.stringify({ status: '1', pois: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function assertProviderError(
  error: unknown,
  code: AmapProviderError['code'],
  message: string,
): boolean {
  assert.ok(error instanceof AmapProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.equal(error.message.includes(TEST_KEY), false);
  assert.equal(String(error).includes(TEST_KEY), false);
  return true;
}

test('requests /v3/place/text with injected key and returns JSON', async () => {
  const capturedUrls: URL[] = [];
  const fakeFetch = createCapturingFetch(capturedUrls);
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);
  const params = {
    keywords: '上海博物馆',
    city: '上海',
    citylimit: true,
    offset: 10,
    page: 1,
    extensions: 'base',
    ignored: undefined,
  };

  const result = await client.get('/v3/place/text', params);

  assert.deepEqual(result, { status: '1', pois: [] });
  assert.equal(capturedUrls.length, 1);

  const url = capturedUrls[0];
  assert.equal(url.origin, 'https://restapi.amap.com');
  assert.equal(url.pathname, '/v3/place/text');
  assert.equal(url.searchParams.get('keywords'), '上海博物馆');
  assert.equal(url.searchParams.get('city'), '上海');
  assert.equal(url.searchParams.get('citylimit'), 'true');
  assert.equal(url.searchParams.get('offset'), '10');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('extensions'), 'base');
  assert.equal(url.searchParams.has('ignored'), false);
  assert.equal(url.searchParams.has('key'), true);
  assert.equal(url.searchParams.get('key')?.length, TEST_KEY.length);
  assert.deepEqual(params, {
    keywords: '上海博物馆',
    city: '上海',
    citylimit: true,
    offset: 10,
    page: 1,
    extensions: 'base',
    ignored: undefined,
  });
});

test('rejects unsupported paths before fetch', async () => {
  const capturedUrls: URL[] = [];
  const fakeFetch = createCapturingFetch(capturedUrls);
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);
  const unsupportedPaths = [
    'https://example.com',
    'http://example.com',
    '//example.com',
    'v3/place/text',
    '/v3/direction/bicycling',
    '/v3/direction/transit/integrated',
  ];

  for (const path of unsupportedPaths) {
    await assert.rejects(
      () => client.get(path, { keywords: '上海博物馆' }),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        return true;
      },
    );
  }

  assert.equal(capturedUrls.length, 0);
});

test('allows only the fixed POI, driving, and walking paths', async () => {
  const capturedUrls: URL[] = [];
  const fakeFetch = createCapturingFetch(capturedUrls);
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);
  const allowedPaths = [
    '/v3/place/text',
    '/v3/place/detail',
    '/v3/direction/driving',
    '/v3/direction/walking',
  ];

  for (const path of allowedPaths) {
    await client.get(path, { origin: '121.1,31.1', destination: '121.2,31.2' });
  }

  assert.deepEqual(
    capturedUrls.map((url) => url.pathname),
    allowedPaths,
  );
});

test('rejects a blank API key before fetch', async () => {
  const capturedUrls: URL[] = [];
  const fakeFetch = createCapturingFetch(capturedUrls);
  const client = new AmapWebServiceHttpClient('   ', fakeFetch);

  await assert.rejects(
    () => client.get('/v3/place/text', { keywords: '上海博物馆' }),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.message.includes('   '), false);
      return true;
    },
  );

  assert.equal(capturedUrls.length, 0);
});

test('rejects protected Amap parameters before fetch', async () => {
  const forbiddenNames = ['key', 'jscode', 'sig', 'callback'] as const;

  for (const name of forbiddenNames) {
    const capturedUrls: URL[] = [];
    const fakeFetch = createCapturingFetch(capturedUrls);
    const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);
    const params: Record<string, string> = {
      keywords: '上海博物馆',
      [name]: 'caller-supplied',
    };

    await assert.rejects(
      () => client.get('/v3/place/text', params),
      (error: unknown) => {
        assertProviderError(
          error,
          'INVALID_REQUEST',
          '不允许传入受保护的高德请求参数。',
        );
        return true;
      },
    );

    assert.equal(capturedUrls.length, 0);
    assert.deepEqual(params, {
      keywords: '上海博物馆',
      [name]: 'caller-supplied',
    });
  }
});

test('converts network failures into a provider error', async () => {
  const fakeFetch: FetchLike = async () => {
    throw new Error('socket hang up at restapi.amap.com');
  };
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);

  await assert.rejects(
    () => client.get('/v3/place/text', { keywords: '上海博物馆' }),
    (error: unknown) => {
      assertProviderError(error, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('socket hang up'), false);
      assert.equal(error.message.includes('restapi.amap.com'), false);
      return true;
    },
  );
});

test('converts non-2xx responses without reading the upstream body', async () => {
  const fakeFetch: FetchLike = async () =>
    new Response('upstream failure', { status: 429 });
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);

  await assert.rejects(
    () => client.get('/v3/place/text', { keywords: '上海博物馆' }),
    (error: unknown) => {
      assertProviderError(error, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('upstream failure'), false);
      assert.equal(error.message.includes('restapi.amap.com'), false);
      return true;
    },
  );
});

test('converts JSON parse failures into a provider error', async () => {
  const fakeFetch: FetchLike = async () =>
    new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch);

  await assert.rejects(
    () => client.get('/v3/place/text', { keywords: '上海博物馆' }),
    (error: unknown) => {
      assertProviderError(error, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('Unexpected'), false);
      assert.equal(error.message.includes('<html>'), false);
      return true;
    },
  );
});

test('aborts a hanging request after the timeout', async () => {
  let receivedSignal: AbortSignal | undefined;
  const fakeFetch: FetchLike = (_input, init) => {
    const signal = init?.signal ?? undefined;
    receivedSignal = signal;
    return new Promise((_resolve, reject) => {
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  };
  const client = new AmapWebServiceHttpClient(TEST_KEY, fakeFetch, 5);

  await assert.rejects(
    () => client.get('/v3/place/text', { keywords: '上海博物馆' }),
    (error: unknown) => {
      assertProviderError(error, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      return true;
    },
  );

  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);
});
