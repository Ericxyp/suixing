import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import {
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
} from '../server/services/ai-provider';
import type {
  TripChangeContext,
  TripChangeIntent,
  TripChangeIntentExtractor,
} from '../server/services/trip-change-intent-extractor';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const context: TripChangeContext = {
  tripId: 'trip-001',
  destination: '北京',
  days: [
    {
      dayNumber: 1,
      stops: [{
        tripPlaceId: 'trip-001:day:1:stop:1',
        placeName: '故宫博物院',
        type: 'attraction',
        startTime: '10:00',
      }],
    },
    {
      dayNumber: 2,
      stops: [{
        tripPlaceId: 'trip-001:day:2:stop:1',
        placeName: '长城',
        type: 'attraction',
        startTime: '10:00',
      }],
    },
  ],
};

const replaceIntent: TripChangeIntent = {
  status: 'ready',
  summary: '将第二天的长城换成颐和园附近地点。',
  operations: [{
    type: 'REPLACE_PLACE',
    dayNumber: 2,
    targetTripPlaceId: 'trip-001:day:2:stop:1',
    replacementQuery: '颐和园',
  }],
};

class FakeExtractor implements TripChangeIntentExtractor {
  calls: Array<{ input: string; context: TripChangeContext }> = [];

  constructor(
    private readonly handler: () => Promise<TripChangeIntent> = async () => structuredClone(replaceIntent),
  ) {}

  async interpret(input: string, context: TripChangeContext): Promise<TripChangeIntent> {
    this.calls.push({ input, context: structuredClone(context) });
    return this.handler();
  }
}

async function request(
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    extractor?: TripChangeIntentExtractor;
  } = {},
): Promise<{ status: number; body: unknown; text: string; contentType: string }> {
  const server = createServer(
    createApp(config, { tripChangeIntentExtractor: options.extractor }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ai/trips/change/interpret`,
      {
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body,
      },
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return {
      status: response.status,
      body,
      text,
      contentType: response.headers.get('content-type') ?? '',
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    input: '第二天不要去长城了，换成颐和园附近。',
    context,
    ...overrides,
  });
}

function assertNoSensitiveLeak(text: string): void {
  for (const secret of [
    'test-dashscope-api-key',
    'dashscope.aliyuncs.com',
    'qwen3.7-plus',
    'Authorization',
    'Bearer',
    'trip_change_intent',
    'json_schema',
    '<change_request>',
    'RAW_UPSTREAM',
    'FAKE_STACK_SECRET',
    'Unexpected token',
    'SyntaxError',
    'stack',
    'prompt',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('returns a structured replace intent without applying a trip', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: jsonHeaders(),
    body: validBody(),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { intent: replaceIntent } });
  assert.equal(extractor.calls.length, 1);
  assert.equal(JSON.stringify(result.body).includes('latitude'), false);
  assert.equal(JSON.stringify(result.body).includes('polyline'), false);
  assertNoSensitiveLeak(result.text);
});

test('returns 503 when the extractor is not injected', async () => {
  const result = await request({
    headers: jsonHeaders(),
    body: validBody(),
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: { code: 'AI_PROVIDER_UNAVAILABLE', message: AI_UNAVAILABLE_MESSAGE },
  });
  assertNoSensitiveLeak(result.text);
});

test('rejects illegal bodies without calling AI', async () => {
  const extractor = new FakeExtractor();
  const cases = [
    JSON.stringify({}),
    JSON.stringify({ input: '改行程' }),
    JSON.stringify({ input: '改行程', context, model: 'qwen3.7-plus' }),
    JSON.stringify({ input: '改行程', context, key: 'secret' }),
    JSON.stringify({
      input: '改行程',
      context: { ...context, totalBudget: 3000 },
    }),
    JSON.stringify({
      input: '改行程',
      context: {
        ...context,
        days: [{
          dayNumber: 1,
          stops: [{
            ...context.days[0].stops[0],
            latitude: 39.9,
            longitude: 116.4,
            address: '北京市',
          }],
        }],
      },
    }),
    JSON.stringify({
      input: '改行程',
      context: { ...context, routes: [{ polyline: [[116, 39]] }] },
    }),
    JSON.stringify({
      input: '改行程',
      trip: { id: 'trip-001', destination: '北京' },
      context,
    }),
  ];
  for (const body of cases) {
    const result = await request({
      extractor,
      headers: jsonHeaders(),
      body,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '行程修改请求无效，请调整后重试。' },
    });
    assertNoSensitiveLeak(result.text);
  }
  assert.equal(extractor.calls.length, 0);
});

test('rejects a non-JSON content type with 415', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: { 'content-type': 'text/plain' },
    body: validBody(),
  });
  assert.equal(result.status, 415);
  assert.equal(extractor.calls.length, 0);
});

test('converts malformed JSON into a stable JSON 400', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: jsonHeaders(),
    body: '{',
  });
  assert.equal(result.status, 400);
  assert.match(result.contentType, /application\/json/);
  assert.equal(extractor.calls.length, 0);
  assertNoSensitiveLeak(result.text);
});

test('rejects non-POST methods with JSON 405', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    method: 'GET',
    headers: jsonHeaders(),
  });
  assert.equal(result.status, 405);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '仅支持理解行程修改意图。' },
  });
  assert.equal(extractor.calls.length, 0);
});

test('maps provider failures and invalid model JSON without leaking internals', async () => {
  const providerError = await request({
    extractor: new FakeExtractor(async () => {
      throw new AiProviderError('AI_PROVIDER_ERROR', 'RAW_UPSTREAM dashscope.aliyuncs.com');
    }),
    headers: jsonHeaders(),
    body: validBody(),
  });
  assert.equal(providerError.status, 502);
  assert.deepEqual(providerError.body, {
    error: { code: 'AI_PROVIDER_ERROR', message: AI_PROVIDER_ERROR_MESSAGE },
  });
  assertNoSensitiveLeak(providerError.text);

  const invalid = await request({
    extractor: new FakeExtractor(async () => {
      throw new AiProviderError('AI_INVALID_RESPONSE', 'RAW_UPSTREAM not json');
    }),
    headers: jsonHeaders(),
    body: validBody(),
  });
  assert.equal(invalid.status, 502);
  assert.deepEqual(invalid.body, {
    error: { code: 'AI_INVALID_RESPONSE', message: AI_INVALID_RESPONSE_MESSAGE },
  });
  assertNoSensitiveLeak(invalid.text);
});
