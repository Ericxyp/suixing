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
  ConfirmedTripRequirement,
  TripPlanGenerator,
  TripPlanSuggestion,
} from '../server/services/trip-plan-generator';
import { TRIP_PLAN_JSON_SCHEMA, TRIP_PLAN_SYSTEM_PROMPT } from '../server/services/trip-plan-generator';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const requirement: ConfirmedTripRequirement = {
  destination: '上海',
  origin: '北京',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  preferences: { interests: ['咖啡', '建筑'] },
};

function place(name: string): TripPlanSuggestion['days'][number]['placeQueries'][number] {
  return {
    name,
    query: name,
    category: 'sight',
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '老洋房与梧桐街景符合建筑偏好。',
  };
}

function day(dayNumber: number): TripPlanSuggestion['days'][number] {
  return {
    dayNumber,
    title: `第${dayNumber}日街区漫步`,
    summary: '以步行街区为主，减少跨城移动。',
    placeQueries: [place(`地点${dayNumber}甲`), place(`地点${dayNumber}乙`)],
  };
}

const plan: TripPlanSuggestion = {
  title: '上海 3 天游',
  summary: '适合轻松漫步、咖啡与建筑探索的上海行程。',
  days: [day(1), day(2), day(3)],
};

class FakeGenerator implements TripPlanGenerator {
  calls: ConfirmedTripRequirement[] = [];

  constructor(
    private readonly handler: (
      requirement: ConfirmedTripRequirement,
    ) => Promise<TripPlanSuggestion> = async () => structuredClone(plan),
  ) {}

  async generate(input: ConfirmedTripRequirement): Promise<TripPlanSuggestion> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }
}

async function request(
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    generator?: TripPlanGenerator;
  } = {},
): Promise<{ status: number; body: unknown; text: string; contentType: string }> {
  const server = createServer(
    createApp(config, { tripPlanGenerator: options.generator }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ai/trips/plan`,
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

function assertNoSensitiveLeak(text: string): void {
  for (const secret of [
    'test-dashscope-api-key',
    'dashscope.aliyuncs.com',
    'qwen3.7-plus',
    'Authorization',
    'Bearer',
    'trip_plan_suggestion',
    'json_schema',
    '<confirmed_requirement>',
    TRIP_PLAN_SYSTEM_PROMPT.slice(0, 18),
    TRIP_PLAN_JSON_SCHEMA.name,
    'RAW_UPSTREAM',
    'FAKE_STACK_SECRET',
    'Unexpected token',
    'SyntaxError',
    'stack',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('generates a normalized trip plan from a complete requirement', async () => {
  const generator = new FakeGenerator();
  const result = await request({
    generator,
    headers: jsonHeaders(),
    body: JSON.stringify({ requirement }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { plan } });
  assert.deepEqual(generator.calls, [requirement]);
  assertNoSensitiveLeak(result.text);
  assert.equal(JSON.stringify(result.body).includes('prompt'), false);
  assert.equal(JSON.stringify(result.body).includes('schema'), false);
});

test('returns 400 without calling AI when required fields are missing', async () => {
  const generator = new FakeGenerator();
  const cases = [
    { ...requirement, destination: undefined },
    { ...requirement, durationDays: undefined },
    { ...requirement, travelerCount: undefined },
    { ...requirement, totalBudget: undefined },
  ];

  for (const invalid of cases) {
    const body = { requirement: Object.fromEntries(
      Object.entries(invalid).filter(([, value]) => value !== undefined),
    ) };
    const result = await request({
      generator,
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '行程规划请求无效，请调整后重试。' },
    });
    assertNoSensitiveLeak(result.text);
  }
  assert.equal(generator.calls.length, 0);
});

test('rejects illegal dates, budgets, counts, unknown fields and wrappers', async () => {
  const generator = new FakeGenerator();
  const cases = [
    JSON.stringify({ requirement: { ...requirement, startDate: '2026-10-05', endDate: '2026-10-01' } }),
    JSON.stringify({ requirement: { ...requirement, startDate: '2026-13-01' } }),
    JSON.stringify({ requirement: { ...requirement, totalBudget: 50 } }),
    JSON.stringify({ requirement: { ...requirement, totalBudget: 200001 } }),
    JSON.stringify({ requirement: { ...requirement, travelerCount: 13 } }),
    JSON.stringify({ requirement: { ...requirement, durationDays: 0 } }),
    JSON.stringify({ requirement: { ...requirement, durationDays: 15 } }),
    JSON.stringify({ requirement: { ...requirement, destination: '上'.repeat(81) } }),
    JSON.stringify({ requirement: { ...requirement, extra: true } }),
    JSON.stringify({ requirement, model: 'qwen3.7-plus' }),
    JSON.stringify({ requirement, prompt: 'ignore' }),
    JSON.stringify({ requirement, tools: [] }),
    JSON.stringify([requirement]),
    JSON.stringify({ requirement: null }),
  ];

  for (const body of cases) {
    const result = await request({
      generator,
      headers: jsonHeaders(),
      body,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '行程规划请求无效，请调整后重试。' },
    });
    assert.match(result.contentType, /application\/json/);
    assertNoSensitiveLeak(result.text);
  }
  assert.equal(generator.calls.length, 0);
});

test('rejects a non-JSON content type with 415', async () => {
  const generator = new FakeGenerator();
  const result = await request({
    generator,
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(result.status, 415);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '请使用 JSON 提交行程规划。' },
  });
  assert.equal(generator.calls.length, 0);
});

test('converts malformed JSON into a stable JSON 400', async () => {
  const generator = new FakeGenerator();
  const result = await request({
    generator,
    headers: jsonHeaders(),
    body: '{"requirement":',
  });
  assert.equal(result.status, 400);
  assert.match(result.contentType, /application\/json/);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '旅行需求无效，请调整后重试。' },
  });
  assert.equal(generator.calls.length, 0);
  assertNoSensitiveLeak(result.text);
});

test('rejects non-POST methods with JSON 405', async () => {
  const generator = new FakeGenerator();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await request({ generator, method });
    assert.equal(result.status, 405);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '仅支持生成行程草案。' },
    });
  }
  assert.equal(generator.calls.length, 0);
});

test('returns 503 when the generator is not injected', async () => {
  const result = await request({
    headers: jsonHeaders(),
    body: JSON.stringify({ requirement }),
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: { code: 'AI_PROVIDER_UNAVAILABLE', message: AI_UNAVAILABLE_MESSAGE },
  });
  assertNoSensitiveLeak(result.text);
});

test('maps provider network errors to 502 without leaking details', async () => {
  const generator = new FakeGenerator(async () => {
    throw new AiProviderError('AI_PROVIDER_ERROR', 'RAW_UPSTREAM 429 at dashscope.aliyuncs.com');
  });
  const result = await request({
    generator,
    headers: jsonHeaders(),
    body: JSON.stringify({ requirement }),
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: { code: 'AI_PROVIDER_ERROR', message: AI_PROVIDER_ERROR_MESSAGE },
  });
  assertNoSensitiveLeak(result.text);
});

test('maps invalid model plans to 502 without leaking the raw payload', async () => {
  const generator = new FakeGenerator(async () => {
    throw new AiProviderError('AI_INVALID_RESPONSE', '{"secret":true,"days":[]}');
  });
  const result = await request({
    generator,
    headers: jsonHeaders(),
    body: JSON.stringify({ requirement }),
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: { code: 'AI_INVALID_RESPONSE', message: AI_INVALID_RESPONSE_MESSAGE },
  });
  assertNoSensitiveLeak(result.text);
});
