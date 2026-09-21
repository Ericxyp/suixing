import assert from 'node:assert/strict';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import { ConfirmedTripBuilder, TripBuilderError, type TripBuilder, type TripBuildResult } from '../server/services/trip-builder';
import {
  ServerTripGenerationOrchestrator,
  TRIP_GENERATION_BUDGET_MS,
  TripGenerationIncompleteError,
  TripGenerationTimeoutError,
} from '../server/services/trip-generation-orchestrator';
import type { GenerationStageLog } from '../server/services/generation-logger';
import {
  ConfirmedTripRequirement,
  TripPlanGenerator,
  TripPlanSuggestion,
  TripPlanValidationError,
} from '../server/services/trip-plan-generator';
import type {
  PlaceSearchService,
  ResolvedTripPlanSuggestion,
  TripPlaceResolver,
} from '../server/services/trip-place-resolver';
import type {
  RouteEnrichedTripPlanSuggestion,
  TripRouteEnricher,
} from '../server/services/trip-route-enricher';
import type { Place, Trip } from '../src/domain/trip/types';
import { AiProviderError } from '../server/services/ai-provider';

const requirement: ConfirmedTripRequirement = {
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

const stages: string[] = [];

function placeQuery(name: string) {
  return {
    name,
    query: name,
    category: 'sight' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
  };
}

function suggestion(): TripPlanSuggestion {
  return {
    title: '上海 3 天游',
    summary: '适合轻松漫步的上海行程。',
    days: [1, 2, 3].map((dayNumber) => ({
      dayNumber,
      title: `第${dayNumber}日`,
      summary: '减少跨城移动。',
      placeQueries: [placeQuery(`地点${dayNumber}甲`), placeQuery(`地点${dayNumber}乙`)],
    })),
  };
}

function mappedPlace(id: string, name: string): Place {
  return {
    id,
    provider: 'amap',
    providerPlaceId: id.replace('amap:', ''),
    name,
    address: '上海市黄浦区示例路 1 号',
    latitude: 31.23,
    longitude: 121.47,
    category: 'attraction',
  };
}

function stop(place: Place) {
  return {
    place,
    category: 'sight' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
    sourceQuery: place.name,
  };
}

function resolvedPlan(
  days: Array<ReturnType<typeof stop>[]>,
  unresolved: ResolvedTripPlanSuggestion['unresolved'] = [],
): ResolvedTripPlanSuggestion {
  return {
    title: '上海 3 天游',
    summary: '适合轻松漫步的上海行程。',
    days: days.map((stops, index) => ({
      dayNumber: index + 1,
      title: `第${index + 1}日`,
      summary: '减少跨城移动。',
      stops,
    })),
    unresolved,
  };
}

function enrichedFrom(resolved: ResolvedTripPlanSuggestion, dropRoutes = false): RouteEnrichedTripPlanSuggestion {
  return {
    title: resolved.title,
    summary: resolved.summary,
    unresolved: resolved.unresolved,
    days: resolved.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: day.stops,
      routes: dropRoutes || day.stops.length < 2
        ? []
        : [{
            fromPlaceId: day.stops[0].place.id,
            toPlaceId: day.stops[1].place.id,
            transport: { mode: 'walk' as const, distanceMeters: 800, durationMinutes: 10 },
            polyline: [
              { latitude: day.stops[0].place.latitude, longitude: day.stops[0].place.longitude },
              { latitude: day.stops[1].place.latitude, longitude: day.stops[1].place.longitude },
            ],
          }],
      unresolvedRoutes: dropRoutes && day.stops.length > 1
        ? [{
            fromPlaceId: day.stops[0].place.id,
            toPlaceId: day.stops[1].place.id,
            reason: 'ROUTE_UNAVAILABLE' as const,
          }]
        : [],
    })),
  };
}

function fakeTrip(id: string): Trip {
  return {
    id,
    userId: 'user-demo-001',
    title: '上海 3 天游',
    destination: '上海',
    travelerCount: 2,
    totalBudget: 5000,
    currency: 'CNY',
    pace: 'relaxed',
    preferences: { interests: ['咖啡', '建筑'] },
    status: 'PLANNING',
    days: [],
    routes: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

class FakePlanGenerator implements TripPlanGenerator {
  calls: ConfirmedTripRequirement[] = [];
  lastSignal: AbortSignal | undefined;
  lastPlanDiagnostics?: { retried: boolean; validationReason?: 'INVALID_TIME' | 'STOP_COUNT_OUT_OF_RANGE' | 'NOT_JSON' };

  constructor(private readonly handler: (signal?: AbortSignal) => Promise<TripPlanSuggestion> = async () => suggestion()) {}

  async generate(
    input: ConfirmedTripRequirement,
    options?: { signal?: AbortSignal },
  ): Promise<TripPlanSuggestion> {
    this.calls.push(structuredClone(input));
    this.lastSignal = options?.signal;
    stages.push('plan');
    return this.handler(options?.signal);
  }
}

class FakePlaceResolver implements TripPlaceResolver {
  calls = 0;

  constructor(private readonly handler: () => Promise<ResolvedTripPlanSuggestion>) {}

  async resolve(): Promise<ResolvedTripPlanSuggestion> {
    this.calls += 1;
    stages.push('resolve');
    return this.handler();
  }
}

class FakeRouteEnricher implements TripRouteEnricher {
  calls = 0;

  constructor(private readonly handler: (plan: ResolvedTripPlanSuggestion) => Promise<RouteEnrichedTripPlanSuggestion>) {}

  async enrich(input: { plan: ResolvedTripPlanSuggestion }): Promise<RouteEnrichedTripPlanSuggestion> {
    this.calls += 1;
    if (this.calls === 1) {
      stages.push('enrich');
    }
    return this.handler(input.plan);
  }
}

class FakePlaceSearch implements PlaceSearchService {
  calls = 0;

  async search(input: { query: string }): Promise<Place[]> {
    this.calls += 1;
    if (!/餐厅|晚餐/.test(input.query)) {
      return [];
    }
    return [{
      id: `amap:FOOD:${this.calls}`,
      provider: 'amap',
      providerPlaceId: `food-${this.calls}`,
      name: `用餐点${this.calls}`,
      address: '上海市黄浦区示例路 2 号',
      latitude: 31.2305,
      longitude: 121.4705,
      category: 'restaurant',
    }];
  }
}

class FakeBuilder implements TripBuilder {
  calls = 0;
  lastPlanningPolicy: { targetCorePlacesPerDay?: 2 | 3 } | undefined;

  constructor(private readonly handler: () => TripBuildResult = () => ({
    trip: fakeTrip('trip-fixed'),
    places: [],
    diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 0 },
  })) {}

  build(input: { planningPolicy?: { targetCorePlacesPerDay?: 2 | 3 } }): TripBuildResult {
    this.calls += 1;
    this.lastPlanningPolicy = input.planningPolicy;
    stages.push('build');
    return this.handler();
  }
}

function completeResolved(): ResolvedTripPlanSuggestion {
  return resolvedPlan([
    [stop(mappedPlace('amap:D1A', '武康路')), stop(mappedPlace('amap:D1B', '安福路'))],
    [stop(mappedPlace('amap:D2A', '外滩')), stop(mappedPlace('amap:D2B', '豫园'))],
    [stop(mappedPlace('amap:D3A', '人民广场')), stop(mappedPlace('amap:D3B', '豫园花园'))],
  ]);
}

function orchestrator(
  overrides: {
    plan?: FakePlanGenerator;
    resolve?: FakePlaceResolver;
    enrich?: FakeRouteEnricher;
    build?: FakeBuilder;
    logs?: GenerationStageLog[];
    budgetMs?: number;
  } = {},
) {
  const plan = overrides.plan ?? new FakePlanGenerator();
  const resolve = overrides.resolve ?? new FakePlaceResolver(async () => completeResolved());
  const enrich = overrides.enrich ?? new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved));
  const build = overrides.build ?? new FakeBuilder();
  const logs = overrides.logs;
  return {
    plan,
    resolve,
    enrich,
    build,
    logs,
    subject: new ServerTripGenerationOrchestrator({
      planGenerator: plan,
      placeResolver: resolve,
      routeEnricher: enrich,
      tripBuilder: build,
      placeSearch: new FakePlaceSearch(),
      userId: 'user-demo-001',
      budgetMs: overrides.budgetMs,
      logger: logs
        ? { logStage: (entry) => logs.push(entry) }
        : undefined,
    }),
  };
}

test('parents low-walking policy is passed to the trip builder', async () => {
  const build = new FakeBuilder();
  const { subject } = orchestrator({ build });
  await subject.generate({
    requirement: {
      ...requirement,
      destination: '北京',
      travelerCount: 3,
      pace: 'balanced',
      partyContext: {
        partyType: 'parents',
        hasElderly: true,
        mobilityRequirement: 'low_walking',
      },
      constraints: { excludedInterestKeys: [], lowWalking: true },
    },
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(build.lastPlanningPolicy?.targetCorePlacesPerDay, 2);
});

test('runs plan, resolve, enrich and build in order and returns diagnostics', async () => {
  stages.length = 0;
  const { subject, plan, resolve, enrich, build } = orchestrator({
    build: new FakeBuilder(() => ({
      trip: fakeTrip('trip-fixed'),
      places: [],
      diagnostics: { unresolvedPlacesCount: 1, unresolvedRoutesCount: 2 },
    })),
  });
  const original = structuredClone(requirement);
  const result = await subject.generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.deepEqual(stages, ['plan', 'resolve', 'enrich', 'build']);
  assert.equal(result.trip.id, 'trip-fixed');
  assert.deepEqual(result.diagnostics, { unresolvedPlacesCount: 1, unresolvedRoutesCount: 2 });
  assert.deepEqual(requirement, original);
  assert.equal(plan.calls.length, 1);
  assert.equal(resolve.calls, 1);
  assert.ok(enrich.calls >= 1);
  assert.equal(build.calls, 1);
  assert.equal(JSON.stringify(result).includes('coreCoverage'), false);
  assert.equal(JSON.stringify(result).includes('DayCombinationScoreV1'), false);
  assert.equal(JSON.stringify(result).includes('StyleFulfillmentAuditV1'), false);
  assert.equal(JSON.stringify(result).includes('partially_met'), false);
});

test('records safe stage logs for the success path', async () => {
  const logs: GenerationStageLog[] = [];
  const { subject } = orchestrator({ logs });
  await subject.generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
    requestId: 'gtestrqid0001',
  });
  assert.deepEqual(
    logs.map((entry) => entry.stage),
    ['plan', 'place_resolve', 'route_enrich', 'time_schedule', 'trip_build'],
  );
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'outcome', 'requestId', 'stage']);
    assert.equal(entry.requestId, 'gtestrqid0001');
    assert.equal(entry.outcome, 'success');
    assert.equal(typeof entry.durationMs, 'number');
  }
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('上海'), false);
  assert.equal(serialized.includes('武康路'), false);
  assert.equal(serialized.includes('dashscope'), false);
  assert.equal(serialized.includes('amap.com'), false);
});

test('failed stages keep a locatable errorCode without leaking internals', async () => {
  const logs: GenerationStageLog[] = [];
  const { subject } = orchestrator({
    logs,
    plan: new FakePlanGenerator(async () => {
      throw new AiProviderError('AI_INVALID_RESPONSE', 'raw dump at dashscope.aliyuncs.com');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
      requestId: 'gfailplan0001',
    }),
    (error: unknown) => error instanceof AiProviderError,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, 'plan');
  assert.equal(logs[0].outcome, 'failed');
  assert.equal(logs[0].errorCode, 'AI_INVALID_RESPONSE');
  assert.equal(JSON.stringify(logs).includes('dashscope'), false);
});

test('plan retry success is logged as retried and continues generation', async () => {
  const logs: GenerationStageLog[] = [];
  const plan = new FakePlanGenerator();
  plan.lastPlanDiagnostics = { retried: true, validationReason: 'INVALID_TIME' };
  const { subject, resolve, enrich, build } = orchestrator({ logs, plan });
  await subject.generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
    requestId: 'gretryplan0001',
  });
  assert.equal(logs[0]?.stage, 'plan');
  assert.equal(logs[0]?.outcome, 'retried');
  assert.equal(logs[0]?.errorCode, 'AI_INVALID_RESPONSE');
  assert.equal(logs[0]?.validationReason, 'INVALID_TIME');
  assert.equal(resolve.calls, 1);
  assert.ok(enrich.calls >= 1);
  assert.equal(build.calls, 1);
  assert.equal(JSON.stringify(logs).includes('上海'), false);
});

test('invalid plan after retry does not call place, route or builder', async () => {
  const { subject, resolve, enrich, build } = orchestrator({
    plan: new FakePlanGenerator(async () => {
      throw new TripPlanValidationError('STOP_COUNT_OUT_OF_RANGE');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof TripPlanValidationError,
  );
  assert.equal(resolve.calls, 0);
  assert.equal(enrich.calls, 0);
  assert.equal(build.calls, 0);
});

test('total budget abort cancels in-flight plan work and does not build', async () => {
  const logs: GenerationStageLog[] = [];
  let sawAbort = false;
  const { subject, resolve, enrich, build } = orchestrator({
    logs,
    budgetMs: 20,
    plan: new FakePlanGenerator(async (signal): Promise<TripPlanSuggestion> => {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          sawAbort = true;
          reject(new Error('already aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });
      throw new Error('unreachable');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
      requestId: 'gtimeout000001',
    }),
    (error: unknown) => error instanceof TripGenerationTimeoutError,
  );
  assert.equal(sawAbort, true);
  assert.equal(resolve.calls, 0);
  assert.equal(enrich.calls, 0);
  assert.equal(build.calls, 0);
  assert.equal(logs[0]?.stage, 'plan');
  assert.equal(logs[0]?.outcome, 'timed_out');
  assert.equal(logs[0]?.errorCode, 'TRIP_GENERATION_TIMEOUT');
  assert.equal(TRIP_GENERATION_BUDGET_MS, 105_000);
});

test('does not enrich or build when a day has fewer than two resolved stops', async () => {
  stages.length = 0;
  const logs: GenerationStageLog[] = [];
  const { subject, enrich, build } = orchestrator({
    logs,
    resolve: new FakePlaceResolver(async () => resolvedPlan([
      [stop(mappedPlace('amap:D1A', '武康路')), stop(mappedPlace('amap:D1B', '安福路'))],
      [stop(mappedPlace('amap:D2A', '外滩'))],
      [stop(mappedPlace('amap:D3A', '人民广场')), stop(mappedPlace('amap:D3B', '豫园花园'))],
    ])),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
      requestId: 'gplacelogs0001',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripGenerationIncompleteError);
      assert.equal(error.validationReason, 'INSUFFICIENT_CORE_PLACES');
      return true;
    },
  );
  assert.deepEqual(stages, ['plan', 'resolve']);
  assert.equal(enrich.calls, 0);
  assert.equal(build.calls, 0);
  const failed = logs.find((entry) => entry.stage === 'place_resolve' && entry.outcome === 'failed');
  assert.equal(failed?.errorCode, 'TRIP_GENERATION_INCOMPLETE');
  assert.equal(failed?.validationReason, 'INSUFFICIENT_CORE_PLACES');
  assert.equal(JSON.stringify(logs).includes('外滩'), false);
  assert.equal(JSON.stringify(logs).includes('stack'), false);
});

test('place_resolve insufficient core places logs a safe validationReason', async () => {
  const logs: GenerationStageLog[] = [];
  const { subject } = orchestrator({
    logs,
    resolve: new FakePlaceResolver(async () => resolvedPlan([
      [stop(mappedPlace('amap:D1A', '武康路'))],
      [stop(mappedPlace('amap:D2A', '外滩')), stop(mappedPlace('amap:D2B', '豫园'))],
      [stop(mappedPlace('amap:D3A', '人民广场')), stop(mappedPlace('amap:D3B', '豫园花园'))],
    ])),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
      requestId: 'gcorefail00001',
    }),
    (error: unknown) => error instanceof TripGenerationIncompleteError,
  );
  const failed = logs.find((entry) => entry.stage === 'place_resolve' && entry.outcome === 'failed');
  assert.equal(failed?.errorCode, 'TRIP_GENERATION_INCOMPLETE');
  assert.equal(failed?.validationReason, 'INSUFFICIENT_CORE_PLACES');
  assert.deepEqual(
    Object.keys(failed ?? {}).sort(),
    ['durationMs', 'errorCode', 'outcome', 'requestId', 'stage', 'validationReason'],
  );
});

test('does not call place, route or builder when the plan generator fails', async () => {
  stages.length = 0;
  const { subject, resolve, enrich, build } = orchestrator({
    plan: new FakePlanGenerator(async () => {
      throw new AiProviderError('AI_INVALID_RESPONSE', 'leaky raw json');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof AiProviderError,
  );
  assert.equal(resolve.calls, 0);
  assert.equal(enrich.calls, 0);
  assert.equal(build.calls, 0);
});

test('keeps a displayable trip when every route is missing', async () => {
  const { subject } = orchestrator({
    enrich: new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved, true)),
    build: new FakeBuilder(() => ({
      trip: fakeTrip('trip-fixed'),
      places: [],
      diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 2 },
    })),
  });
  const result = await subject.generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(result.trip.destination, '上海');
  assert.equal(result.diagnostics.unresolvedRoutesCount, 2);
});

test('route provider outages still build a trip from resolved stops', async () => {
  const { subject, build } = orchestrator({
    enrich: new FakeRouteEnricher(async () => {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com key=leak');
    }),
  });
  const result = await subject.generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(result.trip.id, 'trip-fixed');
  assert.equal(build.calls, 1);
  assert.equal(JSON.stringify(result).includes('amap.com'), false);
});

test('place provider outages propagate as provider errors', async () => {
  const { subject, enrich, build } = orchestrator({
    resolve: new FakePlaceResolver(async () => {
      throw new AmapProviderError('PROVIDER_ERROR', 'ECONNRESET');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof AmapProviderError && error.code === 'PROVIDER_ERROR',
  );
  assert.equal(enrich.calls, 0);
  assert.equal(build.calls, 0);
});

test('orchestrator builds a trip from scheduled times instead of raw AI clocks', async () => {
  const enrich = new FakeRouteEnricher(async (resolved) => {
    const plan = enrichedFrom(resolved);
    const firstDay = plan.days[0];
    firstDay.stops[0] = {
      ...firstDay.stops[0],
      suggestedStartTime: '16:00',
      suggestedDurationMinutes: 120,
    };
    firstDay.stops[1] = {
      ...firstDay.stops[1],
      suggestedStartTime: '19:30',
    };
    firstDay.routes[0] = {
      ...firstDay.routes[0],
      transport: {
        ...firstDay.routes[0].transport,
        durationMinutes: 47,
      },
    };
    return plan;
  });
  const result = await new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(),
    placeResolver: new FakePlaceResolver(async () => completeResolved()),
    routeEnricher: enrich,
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: new FakePlaceSearch(),
    userId: 'user-demo-001',
  }).generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(result.trip.days[0].places[0].startTime, '10:00');
  assert.equal(result.trip.days[0].places[0].placeName, '武康路');
  assert.equal(result.trip.days[0].places[0].durationMinutes, 120);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_slot'), true);
  assert.equal(JSON.stringify(result.trip).includes('自由活动'), false);
  assert.equal(JSON.stringify(result.trip).includes('自由探索'), false);
  assert.equal(result.trip.routes[0].fromTripPlaceId, result.trip.days[0].places[0].id);
});

test('orchestrator applies stay duration policy before route enrich and build', async () => {
  const originalStops = [
    {
      ...stop({
        ...mappedPlace('amap:NAMOC', '中国国家博物馆'),
        address: '北京市东城区东长安街16号',
      }),
      suggestedDurationMinutes: 30,
    },
    stop(mappedPlace('amap:D1B', '安福路')),
  ];
  const snapshot = structuredClone(originalStops);
  const enrich = new FakeRouteEnricher(async (resolved) => {
    if (resolved.days[0].stops.length === 2) {
      assert.equal(resolved.days[0].stops[0].suggestedDurationMinutes, 225);
      assert.equal(JSON.stringify(resolved).includes('PLACE_NAME_RULE'), false);
    }
    return enrichedFrom(resolved);
  });
  const result = await new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(),
    placeResolver: new FakePlaceResolver(async () => resolvedPlan([
      originalStops,
      [stop(mappedPlace('amap:D2A', '外滩')), stop(mappedPlace('amap:D2B', '豫园'))],
      [stop(mappedPlace('amap:D3A', '人民广场')), stop(mappedPlace('amap:D3B', '豫园花园'))],
    ])),
    routeEnricher: enrich,
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: new FakePlaceSearch(),
    userId: 'user-demo-001',
  }).generate({
    requirement,
    tripId: 'trip-fixed',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(originalStops[0].suggestedDurationMinutes, 30);
  assert.deepEqual(originalStops, snapshot);
  assert.equal(result.trip.days[0].places[0].durationMinutes, 225);
  assert.equal(result.trip.days[0].places[0].startTime, '10:00');
  assert.equal(JSON.stringify(result).includes('PLACE_NAME_RULE'), false);
  assert.equal(JSON.stringify(result).includes('PACE_ADJUSTED'), false);
});

test('builder failures propagate without a partial trip', async () => {
  const { subject } = orchestrator({
    build: new FakeBuilder(() => {
      throw new TripBuilderError('INVALID_REQUEST', '行程构建请求无效，请调整后重试。');
    }),
  });
  await assert.rejects(
    () => subject.generate({
      requirement,
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof TripBuilderError,
  );
});

test('does not emit a trip when meals cannot be completed', async () => {
  const emptySearch: PlaceSearchService = {
    async search() {
      return [];
    },
  };
  const subject = new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(),
    placeResolver: new FakePlaceResolver(async () => completeResolved()),
    routeEnricher: new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved)),
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: emptySearch,
    userId: 'user-demo-001',
  });
  await assert.rejects(
    () => subject.generate({
      requirement: { ...requirement, diningMode: 'arranged' },
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof TripGenerationIncompleteError,
  );
});

test('meal search provider errors stay provider failures', async () => {
  const failingSearch: PlaceSearchService = {
    async search() {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com');
    },
  };
  const subject = new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(),
    placeResolver: new FakePlaceResolver(async () => completeResolved()),
    routeEnricher: new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved)),
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: failingSearch,
    userId: 'user-demo-001',
  });
  await assert.rejects(
    () => subject.generate({
      requirement: { ...requirement, diningMode: 'arranged' },
      tripId: 'trip-fixed',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof AmapProviderError && error.code === 'PROVIDER_ERROR',
  );
});

const beijingRequirement: ConfirmedTripRequirement = {
  destination: '北京',
  durationDays: 3,
  travelerCount: 3,
  totalBudget: 3000,
};

function beijingResolved(): ResolvedTripPlanSuggestion {
  return resolvedPlan([
    [stop(mappedPlace('amap:B1A', '安福路')), stop(mappedPlace('amap:B1B', '武康路'))],
    [stop(mappedPlace('amap:B2A', '外滩步道')), stop(mappedPlace('amap:B2B', '豫园花园'))],
    [stop(mappedPlace('amap:B3A', '人民公园')), stop(mappedPlace('amap:B3B', '南京西路'))],
  ]);
}

class CompletingPlaceSearch implements PlaceSearchService {
  async search(input: { query: string }): Promise<Place[]> {
    if (/餐厅|晚餐/.test(input.query)) {
      return [];
    }
    return [{
      id: `amap:CORE:${input.query}`,
      provider: 'amap',
      providerPlaceId: encodeURIComponent(input.query).slice(0, 24),
      name: '太庙',
      address: '北京市东城区东长安街',
      latitude: 31.23,
      longitude: 121.47,
      category: 'attraction',
    }];
  }
}

test('no-preference balanced days complete a third core place before build', async () => {
  const result = await new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(async () => ({
      title: '北京 3 天游',
      summary: '均衡行程。',
      days: [1, 2, 3].map((dayNumber) => ({
        dayNumber,
        title: `第${dayNumber}日`,
        summary: '城区游览。',
        placeQueries: [placeQuery(`地点${dayNumber}甲`), placeQuery(`地点${dayNumber}乙`)],
      })),
    })),
    placeResolver: new FakePlaceResolver(async () => beijingResolved()),
    routeEnricher: new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved)),
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: new CompletingPlaceSearch(),
    userId: 'user-demo-001',
  }).generate({
    requirement: beijingRequirement,
    tripId: 'trip-bj',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  for (const day of result.trip.days) {
    assert.equal(day.places.filter((place) => place.type === 'attraction').length, 3);
    const starts = (day.scheduleItems ?? []).map((item) => item.startTime);
    assert.equal(new Set(starts).size, starts.length);
    assert.equal(day.scheduleItems?.some((item) => item.kind === 'meal_slot'), true);
    assert.equal(day.scheduleItems?.some((item) => item.kind === 'rest' && item.startTime === day.scheduleItems?.find((entry) => entry.kind === 'meal_slot')?.startTime), false);
  }
});

test('balanced days that cannot complete a third core stay incomplete', async () => {
  const emptySearch: PlaceSearchService = {
    async search() {
      return [];
    },
  };
  const subject = new ServerTripGenerationOrchestrator({
    planGenerator: new FakePlanGenerator(),
    placeResolver: new FakePlaceResolver(async () => beijingResolved()),
    routeEnricher: new FakeRouteEnricher(async (resolved) => enrichedFrom(resolved)),
    tripBuilder: new ConfirmedTripBuilder(),
    placeSearch: emptySearch,
    userId: 'user-demo-001',
  });
  await assert.rejects(
    () => subject.generate({
      requirement: beijingRequirement,
      tripId: 'trip-bj',
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    (error: unknown) => (
      error instanceof TripGenerationIncompleteError
      && error.message === '暂时无法补全这一天的可执行安排，请稍后重试或补充偏好。'
    ),
  );
});
