import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import {
  TRIP_CHANGE_INVALID_REQUEST_MESSAGE,
  TRIP_CHANGE_PROVIDER_ERROR_MESSAGE,
  TripChangeExecutionError,
  type ExecuteReplacePlaceInput,
  type ExecuteReplacePlaceResult,
  type TripChangeClock,
  type TripChangeExecutor,
} from '../server/services/trip-change-executor';
import type { GenerationStageLog, GenerationStageLogger } from '../server/services/generation-logger';
import type { Place, Trip } from '../src/domain/trip/types';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const FIXED_NOW = '2026-09-16T12:00:00.000Z';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '北京市东城区示例路 1 号',
    latitude: 39.916,
    longitude: 116.397,
    category: 'attraction',
    ...overrides,
  };
}

const palace = place({ id: 'amap:PALACE', name: '故宫' });
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925 });
const wall = place({ id: 'amap:WALL', name: '八达岭长城', latitude: 40.359, longitude: 116.02 });
const stadium = place({ id: 'amap:STADIUM', name: '国家体育场', latitude: 39.993 });
const summer = place({ id: 'amap:SUMMER', name: '颐和园', latitude: 39.999, longitude: 116.275 });

function sampleTrip(): Trip {
  const day1 = {
    id: 'day-1',
    tripId: 'trip-bj',
    dayNumber: 1,
    date: '2026-09-20',
    title: '城区漫步',
    summary: '故宫与景山。',
    places: [
      {
        id: 'day-1:stop:1',
        dayId: 'day-1',
        order: 1,
        placeId: palace.id,
        placeName: palace.name,
        type: palace.category,
        startTime: '10:00',
        durationMinutes: 90,
        description: '故宫停留。',
        estimatedCost: 0,
        transportToNext: {
          mode: 'taxi' as const,
          durationMinutes: 18,
          distanceMeters: 4200,
        },
      },
      {
        id: 'day-1:stop:2',
        dayId: 'day-1',
        order: 2,
        placeId: park.id,
        placeName: park.name,
        type: park.category,
        startTime: '12:00',
        durationMinutes: 90,
        estimatedCost: 0,
      },
    ],
  };
  const day2 = {
    id: 'day-2',
    tripId: 'trip-bj',
    dayNumber: 2,
    date: '2026-09-21',
    title: '北郊一日',
    summary: '长城与鸟巢。',
    places: [
      {
        id: 'day-2:stop:1',
        dayId: 'day-2',
        order: 1,
        placeId: wall.id,
        placeName: wall.name,
        type: wall.category,
        startTime: '19:30',
        durationMinutes: 90,
        estimatedCost: 0,
      },
      {
        id: 'day-2:stop:2',
        dayId: 'day-2',
        order: 2,
        placeId: stadium.id,
        placeName: stadium.name,
        type: stadium.category,
        startTime: '21:00',
        durationMinutes: 90,
        estimatedCost: 0,
      },
    ],
  };
  return {
    id: 'trip-bj',
    userId: 'user-1',
    title: '北京 2 日游',
    destination: '北京',
    travelerCount: 2,
    totalBudget: 3000,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: ['博物馆'] },
    status: 'PLANNING',
    days: [day1, day2],
    routes: [
      {
        id: 'trip-bj:day:1:route:1',
        dayId: 'day-1',
        fromTripPlaceId: 'day-1:stop:1',
        toTripPlaceId: 'day-1:stop:2',
        transport: { mode: 'taxi', durationMinutes: 18, distanceMeters: 4200 },
        polyline: [
          { latitude: 39.916, longitude: 116.397 },
          { latitude: 39.925, longitude: 116.397 },
        ],
      },
      {
        id: 'trip-bj:day:2:route:1',
        dayId: 'day-2',
        fromTripPlaceId: 'day-2:stop:1',
        toTripPlaceId: 'day-2:stop:2',
        transport: { mode: 'taxi', durationMinutes: 18, distanceMeters: 4200 },
      },
    ],
    createdAt: '2026-09-16T01:00:00.000Z',
    updatedAt: '2026-09-16T02:00:00.000Z',
  };
}

function referencedPlaces(): Place[] {
  return [palace, park, wall, stadium].map((item) => structuredClone(item));
}

function replaceOp() {
  return {
    type: 'REPLACE_PLACE' as const,
    dayNumber: 2,
    targetTripPlaceId: 'day-2:stop:1',
    replacementQuery: '颐和园',
  };
}

function appliedResult(): ExecuteReplacePlaceResult {
  const trip = sampleTrip();
  trip.updatedAt = FIXED_NOW;
  trip.days[1].places[0] = {
    ...trip.days[1].places[0],
    placeId: summer.id,
    placeName: summer.name,
    type: summer.category,
    startTime: '10:00',
  };
  return {
    trip,
    places: [palace, park, summer, stadium],
    summary: {
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      replacedTripPlaceId: 'day-2:stop:1',
      previousPlaceName: '八达岭长城',
      nextPlaceName: '颐和园',
      routeRecalculated: true,
    },
  };
}

class FakeExecutor implements TripChangeExecutor {
  calls: ExecuteReplacePlaceInput[] = [];

  constructor(
    private readonly handler: (input: ExecuteReplacePlaceInput) => Promise<ExecuteReplacePlaceResult> = async () => appliedResult(),
  ) {}

  async replacePlace(input: ExecuteReplacePlaceInput): Promise<ExecuteReplacePlaceResult> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }

  async selectMealPlace(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeClock implements TripChangeClock {
  nowIso(): string {
    return FIXED_NOW;
  }
}

class FakeLogger implements GenerationStageLogger {
  entries: GenerationStageLog[] = [];

  logStage(entry: GenerationStageLog): void {
    this.entries.push({ ...entry });
  }
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trip: sampleTrip(),
    places: referencedPlaces(),
    operation: replaceOp(),
    ...overrides,
  };
}

async function request(options: {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  executor?: TripChangeExecutor;
  clock?: TripChangeClock;
  logger?: GenerationStageLogger;
} = {}): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(createApp(config, {
    tripChangeExecutor: options.executor,
    tripChangeClock: options.clock ?? new FakeClock(),
    generationLogger: options.logger,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/trips/change/apply`, {
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

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

function assertNoSensitiveLeak(text: string): void {
  for (const secret of [
    'restapi.amap.com',
    'key=',
    'jscode',
    'dashscope',
    'test-dashscope-api-key',
    'FAKE_STACK_SECRET',
    'Unexpected token',
    'SyntaxError',
    'stack',
    'prompt',
    'schema',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('applies a legal REPLACE_PLACE snapshot with server-injected updatedAt', async () => {
  const executor = new FakeExecutor();
  const logger = new FakeLogger();
  const result = await request({
    executor,
    logger,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(result.status, 200);
  const expected = appliedResult();
  assert.deepEqual(result.body, { data: expected });
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].updatedAt, FIXED_NOW);
  assert.equal(executor.calls[0].operation.replacementQuery, '颐和园');
  assert.equal(logger.entries.length, 1);
  assert.deepEqual(Object.keys(logger.entries[0]).sort(), ['durationMs', 'outcome', 'requestId', 'stage']);
  assert.equal(logger.entries[0].stage, 'change_apply');
  assert.equal(logger.entries[0].outcome, 'success');
  assert.equal(JSON.stringify(result.body).includes('providerPlaceId') === true, true);
  assert.equal(JSON.stringify(result.body).includes('typecode'), false);
  assertNoSensitiveLeak(result.text);
});

test('rejects top-level updatedAt, context, userId, model, prompt, key and url', async () => {
  const executor = new FakeExecutor();
  const forbidden = [
    { updatedAt: FIXED_NOW },
    { context: { tripId: 'trip-bj' } },
    { userId: 'attacker' },
    { model: 'qwen' },
    { prompt: 'ignore' },
    { key: 'secret' },
    { url: 'https://restapi.amap.com' },
  ];
  for (const extra of forbidden) {
    const result = await request({
      executor,
      headers: jsonHeaders(),
      body: JSON.stringify(validPayload(extra)),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: TRIP_CHANGE_INVALID_REQUEST_MESSAGE },
    });
    assert.equal(executor.calls.length, 0);
    assertNoSensitiveLeak(result.text);
  }
});

test('rejects illegal snapshots before calling the executor', async () => {
  const executor = new FakeExecutor();
  const trip = sampleTrip();
  const cases: unknown[] = [
    validPayload({
      trip: { ...trip, days: [{ ...trip.days[0], extra: true }, trip.days[1]] },
    }),
    validPayload({ places: referencedPlaces().slice(1) }),
    validPayload({ places: [...referencedPlaces(), structuredClone(summer)] }),
    validPayload({
      places: referencedPlaces().map((item, index) => (
        index === 0 ? { ...item, latitude: 999 } : item
      )),
    }),
    validPayload({
      trip: {
        ...trip,
        routes: [{
          ...trip.routes[0],
          fromTripPlaceId: 'day-2:stop:1',
        }],
      },
    }),
    validPayload({ operation: { ...replaceOp(), type: 'REMOVE_PLACE' } }),
    validPayload({ operation: { ...replaceOp(), targetTripPlaceId: 'day-1:stop:1' } }),
    validPayload({ operation: { ...replaceOp(), replacementQuery: '   ' } }),
    validPayload({ operation: { ...replaceOp(), targetTripPlaceId: 'missing' } }),
    validPayload({ trip: { ...trip, foo: 1 } }),
  ];
  for (const body of cases) {
    const result = await request({
      executor,
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(executor.calls.length, 0);
  }
});

test('returns 503 when the executor is not injected', async () => {
  const result = await request({
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: '地点与路线服务尚未配置，请稍后再试。',
    },
  });
});

test('maps TRIP_CHANGE_INCOMPLETE to 422 without leaking the query', async () => {
  const executor = new FakeExecutor(async () => {
    throw new TripChangeExecutionError(
      'TRIP_CHANGE_INCOMPLETE',
      'upstream said 颐和园 https://restapi.amap.com key=secret',
      'NO_MATCH',
    );
  });
  const logger = new FakeLogger();
  const result = await request({
    executor,
    logger,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(result.status, 422);
  assert.deepEqual(result.body, {
    error: {
      code: 'TRIP_CHANGE_INCOMPLETE',
      message: '暂时找不到合适的替换地点，请换一种说法后重试。',
    },
  });
  assert.equal(result.text.includes('颐和园'), false);
  assert.equal(result.text.includes('restapi'), false);
  assert.equal(result.text.includes('validationReason'), false);
  assert.equal(result.text.includes('NO_MATCH'), false);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].stage, 'change_apply');
  assert.equal(logger.entries[0].outcome, 'failed');
  assert.equal(logger.entries[0].errorCode, 'TRIP_CHANGE_INCOMPLETE');
  assert.equal(logger.entries[0].validationReason, 'NO_MATCH');
  assertNoSensitiveLeak(result.text);
});

test('maps provider runtime errors to 502 and unconfigured executor errors to 503', async () => {
  const runtime = new FakeExecutor(async () => {
    throw new TripChangeExecutionError('PROVIDER_ERROR', 'https://restapi.amap.com');
  });
  const runtimeResult = await request({
    executor: runtime,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(runtimeResult.status, 502);
  assert.deepEqual(runtimeResult.body, {
    error: { code: 'PROVIDER_ERROR', message: TRIP_CHANGE_PROVIDER_ERROR_MESSAGE },
  });
  assertNoSensitiveLeak(runtimeResult.text);

  const unavailable = new FakeExecutor(async () => {
    throw new TripChangeExecutionError('PROVIDER_UNAVAILABLE', 'missing key');
  });
  const unavailableResult = await request({
    executor: unavailable,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(unavailableResult.status, 503);
  assert.deepEqual(unavailableResult.body, {
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: '地点与路线服务尚未配置，请稍后再试。',
    },
  });
});

test('rejects non-JSON, malformed JSON and non-POST methods with stable JSON errors', async () => {
  const executor = new FakeExecutor();
  const unsupported = await request({
    executor,
    headers: { 'content-type': 'text/plain' },
    body: 'trip',
  });
  assert.equal(unsupported.status, 415);
  assert.deepEqual(unsupported.body, {
    error: { code: 'INVALID_REQUEST', message: '请使用 JSON 提交行程修改。' },
  });

  const malformed = await request({
    executor,
    headers: jsonHeaders(),
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body, 'object');
  assert.equal((malformed.body as { error: { code: string } }).error.code, 'INVALID_REQUEST');
  assert.equal(malformed.text.includes('Unexpected token'), false);

  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await request({
      executor,
      method,
      headers: jsonHeaders(),
      body: method === 'GET' ? undefined : JSON.stringify(validPayload()),
    });
    assert.equal(result.status, 405);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '仅支持执行行程修改。' },
    });
  }
  assert.equal(executor.calls.length, 0);
});

test('success payload only includes domain trip, internal places and summary', async () => {
  const executor = new FakeExecutor();
  const result = await request({
    executor,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(result.status, 200);
  const body = result.body as {
    data: { trip: Trip; places: Place[]; summary: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(body), ['data']);
  assert.deepEqual(Object.keys(body.data).sort(), ['places', 'summary', 'trip']);
  assert.deepEqual(Object.keys(body.data.summary).sort(), [
    'dayNumber',
    'nextPlaceName',
    'previousPlaceName',
    'replacedTripPlaceId',
    'routeRecalculated',
    'type',
  ]);
  assert.equal('replacementQuery' in body.data.summary, false);
  assert.equal(body.data.places.every((item) => item.provider === 'amap'), true);
  assert.equal(JSON.stringify(body.data.summary).includes('key'), false);
});

test('logger only records allowed change_apply fields', async () => {
  const logger = new FakeLogger();
  const executor = new FakeExecutor(async () => {
    throw new TripChangeExecutionError('PROVIDER_ERROR', 'raw');
  });
  await request({
    executor,
    logger,
    headers: jsonHeaders(),
    body: JSON.stringify(validPayload()),
  });
  assert.equal(logger.entries.length, 1);
  const entry = logger.entries[0];
  assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'errorCode', 'outcome', 'requestId', 'stage']);
  assert.equal(entry.stage, 'change_apply');
  assert.equal(entry.outcome, 'failed');
  assert.equal(entry.errorCode, 'PROVIDER_ERROR');
  assert.equal(JSON.stringify(entry).includes('颐和园'), false);
  assert.equal(JSON.stringify(entry).includes('trip-bj'), false);
});
