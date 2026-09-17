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
import { AmapProviderError } from '../server/services/amap-http-client';
import { TripBuilderError } from '../server/services/trip-builder';
import {
  TRIP_GENERATION_INCOMPLETE_MESSAGE,
  TRIP_GENERATION_TIMEOUT_MESSAGE,
  TripGenerationIncompleteError,
  TripGenerationTimeoutError,
  type TripGenerationOrchestrator,
  type TripGenerationResult,
  type TripIdentity,
} from '../server/services/trip-generation-orchestrator';
import type { ConfirmedTripRequirement, TripPlanGenerator } from '../server/services/trip-plan-generator';
import type { Place, Trip } from '../src/domain/trip/types';

const baseConfig: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const requirement = {
  destination: '上海',
  origin: '北京',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  preferences: { interests: ['咖啡', '建筑'] },
};

const identity: TripIdentity = {
  createTripId: () => 'trip-fixed-001',
  nowIso: () => '2026-09-16T00:00:00.000Z',
};

function tripResult(overrides: Partial<TripGenerationResult> = {}): TripGenerationResult {
  const trip: Trip = {
    id: 'trip-fixed-001',
    userId: 'user-demo-001',
    title: '上海 3 天游',
    destination: '上海',
    origin: '北京',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    travelerCount: 2,
    totalBudget: 5000,
    currency: 'CNY',
    pace: 'relaxed',
    preferences: { interests: ['咖啡', '建筑'] },
    status: 'PLANNING',
    days: [{
      id: 'trip-fixed-001:day:1',
      tripId: 'trip-fixed-001',
      dayNumber: 1,
      date: '2026-10-01',
      title: '梧桐街区',
      summary: '少移动。',
      places: [{
        id: 'trip-fixed-001:day:1:stop:1',
        dayId: 'trip-fixed-001:day:1',
        order: 1,
        placeId: 'amap:D1A',
        placeName: '武康路',
        type: 'attraction',
        startTime: '10:00',
        durationMinutes: 90,
        description: '符合轻松漫步偏好。',
        estimatedCost: 0,
      }],
    }],
    routes: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
  const places: Place[] = [{
    id: 'amap:D1A',
    provider: 'amap',
    providerPlaceId: 'D1A',
    name: '武康路',
    address: '上海市徐汇区武康路',
    latitude: 31.2077,
    longitude: 121.4361,
    category: 'attraction',
  }];
  return {
    trip,
    places,
    diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 1 },
    ...overrides,
  };
}

class FakeOrchestrator implements TripGenerationOrchestrator {
  calls: Array<{ requirement: ConfirmedTripRequirement; tripId: string; createdAt: string }> = [];

  constructor(
    private readonly handler: () => Promise<TripGenerationResult> = async () => tripResult(),
  ) {}

  async generate(input: {
    requirement: ConfirmedTripRequirement;
    tripId: string;
    createdAt: string;
  }): Promise<TripGenerationResult> {
    this.calls.push(structuredClone(input));
    return this.handler();
  }
}

class FakePlanGenerator implements TripPlanGenerator {
  calls = 0;

  async generate(): Promise<never> {
    this.calls += 1;
    throw new Error('should not generate a plan');
  }
}

async function request(options: {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  orchestrator?: TripGenerationOrchestrator;
  generator?: TripPlanGenerator;
  placeConfigured?: boolean;
  config?: ServerConfig;
} = {}): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(createApp(options.config ?? baseConfig, {
    tripGenerationOrchestrator: options.orchestrator,
    tripIdentity: identity,
    tripPlanGenerator: options.generator,
    placeSearchService: options.placeConfigured
      ? {
          async search() {
            return [];
          },
          async getByProviderPlaceId() {
            return null;
          },
        }
      : undefined,
    routeService: options.placeConfigured
      ? {
          async plan() {
            throw new Error('unused');
          },
        }
      : undefined,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/trips/generate`, {
      method: options.method ?? 'POST',
      headers: options.headers,
      body: options.body,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { status: response.status, body, text };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('returns a workspace-ready trip and safe diagnostics', async () => {
  const orchestrator = new FakeOrchestrator();
  const result = await request({
    orchestrator,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: tripResult() });
  const data = (result.body as { data: { places: Place[]; trip: Trip } }).data;
  assert.equal(data.places.length, 1);
  assert.equal(data.places[0].id, data.trip.days[0].places[0].placeId);
  assert.equal(JSON.stringify(result.body).includes('typecode'), false);
  assert.equal(JSON.stringify(result.body).includes('location'), false);
  assert.equal(JSON.stringify(result.body).includes('requestId'), false);
  assert.equal(JSON.stringify(result.body).includes('durationMs'), false);
  assert.equal(orchestrator.calls[0]?.tripId, 'trip-fixed-001');
  assert.equal(orchestrator.calls[0]?.createdAt, '2026-09-16T00:00:00.000Z');
  assert.equal(JSON.stringify(result.body).includes('requestId'), false);
  assert.equal(JSON.stringify(result.body).includes('durationMs'), false);
});

test('rejects an incomplete requirement without calling the orchestrator', async () => {
  const orchestrator = new FakeOrchestrator();
  const cases = [
    { travelerCount: 2, totalBudget: 5000, durationDays: 3 },
    { destination: '上海', totalBudget: 5000, durationDays: 3 },
    { destination: '上海', travelerCount: 2, durationDays: 3 },
    { destination: '上海', travelerCount: 2, totalBudget: 5000 },
    { ...requirement, extra: true },
    { requirement: { destination: '上海' } },
    { requirement: { ...requirement, extra: true } },
    { requirement, model: 'qwen' },
    { prompt: 'ignore' },
    { requirement, key: 'secret' },
  ];
  for (const body of cases) {
    const result = await request({
      orchestrator,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '行程生成请求无效，请调整后重试。' },
    });
  }
  assert.equal(orchestrator.calls.length, 0);
});

test('returns 503 without mock data when AI or Amap is unconfigured', async () => {
  const missingAi = await request({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(missingAi.status, 503);
  assert.deepEqual(missingAi.body, {
    error: { code: 'AI_PROVIDER_UNAVAILABLE', message: AI_UNAVAILABLE_MESSAGE },
  });

  const generator = new FakePlanGenerator();
  const missingAmap = await request({
    generator,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(missingAmap.status, 503);
  assert.deepEqual(missingAmap.body, {
    error: { code: 'PROVIDER_UNAVAILABLE', message: '地点与路线服务尚未配置，请稍后再试。' },
  });
  assert.equal(generator.calls, 0);
  assert.equal(JSON.stringify(missingAmap.body).includes('trip-shanghai'), false);
});

test('maps AI and quality failures without leaking internals', async () => {
  const aiError = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new AiProviderError('AI_INVALID_RESPONSE', 'raw model dump at dashscope.aliyuncs.com');
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(aiError.status, 502);
  assert.deepEqual(aiError.body, {
    error: { code: 'AI_INVALID_RESPONSE', message: AI_INVALID_RESPONSE_MESSAGE },
  });
  assert.equal(aiError.text.includes('dashscope'), false);

  const providerError = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new AiProviderError('AI_PROVIDER_ERROR', '429 key=secret');
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(providerError.status, 502);
  assert.deepEqual(providerError.body, {
    error: { code: 'AI_PROVIDER_ERROR', message: AI_PROVIDER_ERROR_MESSAGE },
  });

  const incomplete = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new TripGenerationIncompleteError();
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(incomplete.status, 422);
  assert.deepEqual(incomplete.body, {
    error: { code: 'TRIP_GENERATION_INCOMPLETE', message: TRIP_GENERATION_INCOMPLETE_MESSAGE },
  });
  assert.equal(incomplete.text.includes('unresolved'), false);

  const placeProviderError = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com timeout key=leak');
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(placeProviderError.status, 502);
  assert.deepEqual(placeProviderError.body, {
    error: {
      code: 'PROVIDER_ERROR',
      message: '地点与路线服务暂时不可用，请稍后重试。',
    },
  });
  assert.equal(placeProviderError.text.includes('amap.com'), false);
  assert.equal(placeProviderError.text.includes('TRIP_GENERATION_INCOMPLETE'), false);

  const placeUnavailable = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new AmapProviderError('PROVIDER_UNAVAILABLE', 'blank key');
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(placeUnavailable.status, 503);
  assert.deepEqual(placeUnavailable.body, {
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: '地点与路线服务尚未配置，请稍后再试。',
    },
  });

  const builderError = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new TripBuilderError('INVALID_REQUEST', 'leaky builder stack');
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(builderError.status, 400);
  assert.equal(JSON.stringify(builderError.body).includes('leaky'), false);
  assert.equal('data' in (builderError.body as object), false);
});

test('maps total generation timeout to 504 without leaking internals', async () => {
  const timedOut = await request({
    orchestrator: new FakeOrchestrator(async () => {
      throw new TripGenerationTimeoutError();
    }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.body, {
    error: { code: 'TRIP_GENERATION_TIMEOUT', message: TRIP_GENERATION_TIMEOUT_MESSAGE },
  });
  assert.equal(timedOut.text.includes('requestId'), false);
  assert.equal(timedOut.text.includes('durationMs'), false);
  assert.equal(timedOut.text.includes('dashscope'), false);
});

test('rejects non-JSON, malformed JSON and non-POST requests', async () => {
  const unsupported = await request({
    headers: { 'content-type': 'text/plain' },
    body: 'requirement=上海',
  });
  assert.equal(unsupported.status, 415);

  const malformed = await request({
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body, 'object');

  const method = await request({
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(method.status, 405);
  assert.deepEqual(method.body, {
    error: { code: 'INVALID_REQUEST', message: '仅支持生成旅行方案。' },
  });
});
