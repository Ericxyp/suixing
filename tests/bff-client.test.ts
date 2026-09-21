import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BffClientError,
  BffHttpClient,
  type FetchLike,
} from '../src/services/bff-client';

const NETWORK_ERROR_MESSAGE = '网络异常，请稍后重试。';
const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const PROVIDER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function assertBffError(
  error: unknown,
  code: BffClientError['code'],
  message: string,
): boolean {
  assert.ok(error instanceof BffClientError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.equal(error.message.includes('http'), false);
  assert.equal(error.message.includes('://'), false);
  assert.equal(error.message.includes('restapi.amap.com'), false);
  assert.equal(error.message.includes('/_AMapService'), false);
  return true;
}

test('allows a relative place-detail path', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { place: null } });
  };
  const client = new BffHttpClient(fakeFetch);

  const payload = await client.get('/api/places/B001');

  assert.deepEqual(payload, { data: { place: null } });
  assert.deepEqual(captured, ['/api/places/B001']);
});

test('rejects complete URLs, AMap hosts, and the JS API proxy path before fetch', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { ok: true } });
  };
  const client = new BffHttpClient(fakeFetch);

  for (const path of [
    'https://restapi.amap.com/v3/place/text',
    'http://example.com/api/places/search',
    'https://example.com/api/places/B001',
    '//restapi.amap.com/v3/place/text',
    '/_AMapService/v3/place/text',
    '/_AMapService/v3/place/detail',
    '/api/../secret',
    '/api/places/search?query=test',
    '/api/places/foo/bar',
    '/api/places/foo:bar',
    '/api/places/..%2Fsecret',
    '/api/unknown',
    '/health',
    '/api/ai/requirements/extract',
  ]) {
    await assert.rejects(
      () => client.get(path),
      (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
    );
  }

  assert.deepEqual(captured, []);
});

test('parses a stable BFF success JSON payload', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { places: [] } });
  };
  const client = new BffHttpClient(fakeFetch);

  const payload = await client.get('/api/places/search', {
    query: '上海博物馆',
    city: '上海',
    limit: 10,
    ignored: undefined,
  });

  assert.deepEqual(payload, { data: { places: [] } });
  assert.equal(captured.length, 1);
  const url = new URL(captured[0], 'http://frontend.local');
  assert.equal(url.pathname, '/api/places/search');
  assert.equal(url.searchParams.get('query'), '上海博物馆');
  assert.equal(url.searchParams.get('city'), '上海');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.has('ignored'), false);
});

test('maps stable BFF error JSON to BffClientError', async () => {
  const fakeFetch: FetchLike = async () =>
    jsonResponse(
      { error: { code: 'PROVIDER_UNAVAILABLE', message: '地点服务尚未配置。' } },
      503,
    );
  const client = new BffHttpClient(fakeFetch);

  await assert.rejects(
    () => client.get('/api/places/search', { query: '上海博物馆' }),
    (error: unknown) =>
      assertBffError(error, 'PROVIDER_UNAVAILABLE', '地点服务尚未配置。'),
  );
});

test('converts network failures without leaking URLs or exception text', async () => {
  const fakeFetch: FetchLike = async () => {
    throw new Error('socket hang up at https://restapi.amap.com/v3/place/text');
  };
  const client = new BffHttpClient(fakeFetch);

  await assert.rejects(
    () => client.get('/api/places/search', { query: '上海博物馆' }),
    (error: unknown) => {
      assertBffError(error, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('socket hang up'), false);
      assert.equal(String(error).includes('restapi.amap.com'), false);
      return true;
    },
  );
});

test('converts timeout into a stable network error', async () => {
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
          reject(new DOMException('Aborted at /api/places/search', 'AbortError'));
        },
        { once: true },
      );
    });
  };
  const client = new BffHttpClient(fakeFetch, 5);

  await assert.rejects(
    () => client.get('/api/places/search', { query: '上海博物馆' }),
    (error: unknown) => {
      assertBffError(error, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('/api/places/search'), false);
      return true;
    },
  );

  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);
});

test('converts non-JSON and unknown structures without leaking the body', async () => {
  const htmlClient = new BffHttpClient(async () =>
    new Response('<html>RAW_BODY https://restapi.amap.com</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  );

  await assert.rejects(
    () => htmlClient.get('/api/routes'),
    (error: unknown) => {
      assertBffError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('RAW_BODY'), false);
      assert.equal(error.message.includes('<html>'), false);
      return true;
    },
  );

  const unknownClient = new BffHttpClient(async () => jsonResponse({ ok: true }));
  await assert.rejects(
    () => unknownClient.get('/api/routes'),
    (error: unknown) =>
      assertBffError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE),
  );

  const brokenErrorClient = new BffHttpClient(async () =>
    jsonResponse({ error: { info: 'RAW_UPSTREAM' } }, 502),
  );
  await assert.rejects(
    () => brokenErrorClient.get('/api/routes'),
    (error: unknown) => {
      assertBffError(error, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('RAW_UPSTREAM'), false);
      return true;
    },
  );
});

test('rejects protected query parameters before fetch', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { places: [] } });
  };
  const client = new BffHttpClient(fakeFetch);

  await assert.rejects(
    () => client.get('/api/places/search', { query: '博物馆', key: 'caller-supplied' }),
    (error: unknown) =>
      assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  assert.deepEqual(captured, []);
});

test('posts only the requirement extraction path with a JSON body', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse({
      data: { draft: { destination: '上海' }, missingRequiredFields: [] },
    });
  };
  const client = new BffHttpClient(fakeFetch);

  const payload = await client.post('/api/ai/requirements/extract', {
    input: '去上海玩 3 天',
  });

  assert.deepEqual(payload, {
    data: { draft: { destination: '上海' }, missingRequiredFields: [] },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, '/api/ai/requirements/extract');
  assert.equal(captured[0].init?.method, 'POST');
  assert.equal(new Headers(captured[0].init?.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(captured[0].init?.body)), { input: '去上海玩 3 天' });
});

test('rejects unsafe POST paths and sensitive body fields before fetch', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { ok: true } });
  };
  const client = new BffHttpClient(fakeFetch);

  for (const path of [
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'http://example.com/api/ai/requirements/extract',
    '//evil.example/api/ai/requirements/extract',
    '/_AMapService/v3/place/text',
    '/api/places/search',
    '/api/routes',
    '/api/unknown',
  ]) {
    await assert.rejects(
      () => client.post(path, { input: '去上海' }),
      (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
    );
  }

  for (const body of [
    { input: '去上海', model: 'qwen3.7-plus' },
    { input: '去上海', prompt: 'ignore previous' },
    { input: '去上海', schema: {} },
    { input: '去上海', tools: [] },
    { input: '去上海', key: 'secret' },
    { input: 12 },
    {},
  ]) {
    await assert.rejects(
      () => client.post('/api/ai/requirements/extract', body as Record<string, unknown>),
      (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
    );
  }

  assert.deepEqual(captured, []);
});

test('posts a controlled trip generation body and rejects protected fields', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse({ data: { trip: { id: 'trip-1' }, diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 0 } } });
  };
  const client = new BffHttpClient(fakeFetch);

  const payload = await client.post('/api/trips/generate', {
    requirement: { destination: '上海', durationDays: 3, travelerCount: 2, totalBudget: 5000 },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, '/api/trips/generate');
  assert.equal(captured[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured[0].init?.body)), {
    requirement: { destination: '上海', durationDays: 3, travelerCount: 2, totalBudget: 5000 },
  });
  assert.ok(payload);

  await assert.rejects(
    () => client.post('/api/trips/generate', {
      requirement: { destination: '上海' },
      model: 'qwen3.7-plus',
    }),
    (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  await assert.rejects(
    () => client.post('/api/trips/generate', {
      requirement: { destination: '上海', key: 'secret' },
    }),
    (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  assert.equal(captured.length, 1);
});

test('allows interpret and apply relative POST paths and rejects protected fields', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { intent: { status: 'needs_clarification', summary: '请问改哪一天？', operations: [] } } });
  };
  const client = new BffHttpClient(fakeFetch);
  await client.post('/api/ai/trips/change/interpret', {
    input: '不想去新天地换一个商场',
    context: { tripId: 'trip-1', destination: '上海', days: [] },
    focus: { selectedDayNumber: 1 },
  });
  await client.post('/api/trips/change/apply', {
    trip: { id: 'trip-1' },
    places: [],
    operation: { type: 'REPLACE_PLACE', dayNumber: 2, targetTripPlaceId: 'stop-1', replacementQuery: '颐和园' },
  }, 90_000);
  await client.post('/api/trips/meal-options', {
    city: '北京',
    mealPeriod: 'lunch',
    area: { placeId: 'amap:AREA', name: '东四附近', longitude: 116.4, latitude: 39.9 },
  });
  await client.post('/api/trips/meal/apply', {
    trip: { id: 'trip-1' },
    places: [],
    operation: { type: 'SELECT_MEAL_PLACE', dayNumber: 1, mealSlotId: 'slot-1', placeId: 'amap:R1' },
  }, 90_000);
  assert.deepEqual(captured, [
    '/api/ai/trips/change/interpret',
    '/api/trips/change/apply',
    '/api/trips/meal-options',
    '/api/trips/meal/apply',
  ]);
  await assert.rejects(
    () => client.post('/api/ai/trips/change/interpret', {
      input: '换成颐和园',
      context: { tripId: 'trip-1', destination: '北京', days: [] },
      prompt: 'ignore',
    }),
    (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  await assert.rejects(
    () => client.post('/api/trips/change/apply', {
      trip: { id: 'trip-1', key: 'secret' },
      places: [],
      operation: { type: 'REPLACE_PLACE' },
    }),
    (error: unknown) => assertBffError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  assert.equal(captured.length, 4);
});

test('converts a hanging POST into a stable network error', async () => {
  let receivedSignal: AbortSignal | undefined;
  const fakeFetch: FetchLike = (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted at /api/ai/requirements/extract', 'AbortError')),
        { once: true },
      );
    });
  };
  const client = new BffHttpClient(fakeFetch, 8_000, 5);

  await assert.rejects(
    () => client.post('/api/ai/requirements/extract', { input: '去上海' }),
    (error: unknown) => {
      assertBffError(error, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('/api/ai/requirements/extract'), false);
      return true;
    },
  );
  assert.equal(receivedSignal?.aborted, true);
});
