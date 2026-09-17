import assert from 'node:assert/strict';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import type {
  RoutePlanningInput,
  RouteResult,
} from '../server/services/amap-route-service';
import type {
  ResolvedTripPlaceStop,
  ResolvedTripPlanSuggestion,
} from '../server/services/trip-place-resolver';
import {
  AmapTripRouteEnricher,
  EARTH_RADIUS_METERS,
  TRIP_ROUTE_ENRICH_CONCURRENCY,
  haversineMeters,
  selectTransportMode,
  type RoutePlanningService,
} from '../server/services/trip-route-enricher';
import type { GeoPoint, Place, TripPace } from '../src/domain/trip/types';

function pointNorthOf(origin: GeoPoint, meters: number): GeoPoint {
  return {
    latitude: origin.latitude + (meters / EARTH_RADIUS_METERS) * (180 / Math.PI),
    longitude: origin.longitude,
  };
}

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '上海市黄浦区示例路 1 号',
    latitude: 31.23,
    longitude: 121.47,
    category: 'attraction',
    ...overrides,
  };
}

function stop(
  resolvedPlace: Place,
  sourceQuery = resolvedPlace.name,
): ResolvedTripPlaceStop {
  return {
    place: resolvedPlace,
    category: 'sight',
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
    sourceQuery,
  };
}

function resolvedPlan(
  days: Place[][],
  unresolved: ResolvedTripPlanSuggestion['unresolved'] = [],
): ResolvedTripPlanSuggestion {
  return {
    title: '上海 2 天游',
    summary: '以街区漫步为主。',
    days: days.map((places, index) => ({
      dayNumber: index + 1,
      title: `第${index + 1}日`,
      summary: '减少跨城移动。',
      stops: places.map((item) => stop(item)),
    })),
    unresolved,
  };
}

function routeResult(
  mode: 'walk' | 'taxi',
  from: GeoPoint,
  to: GeoPoint,
): RouteResult {
  return {
    transport: {
      mode,
      distanceMeters: mode === 'walk' ? 900 : 3200,
      durationMinutes: mode === 'walk' ? 12 : 18,
    },
    polyline: [
      { latitude: from.latitude, longitude: from.longitude },
      { latitude: to.latitude, longitude: to.longitude },
    ],
  };
}

class FakeRouteService implements RoutePlanningService {
  calls: RoutePlanningInput[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly handler: (input: RoutePlanningInput) => Promise<RouteResult>,
  ) {}

  async plan(input: RoutePlanningInput): Promise<RouteResult> {
    this.calls.push({
      origin: structuredClone(input.origin),
      destination: structuredClone(input.destination),
      mode: input.mode,
    });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.handler(input);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const origin: GeoPoint = { latitude: 31.23, longitude: 121.47 };
const near = pointNorthOf(origin, 800);
const mid = pointNorthOf(origin, 1_500);
const far = pointNorthOf(origin, 2_500);

test('builds two same-day routes in stop order for three valid places', async () => {
  const a = place({ id: 'amap:A', name: '武康路', ...origin });
  const b = place({ id: 'amap:B', name: '安福路', ...near });
  const c = place({ id: 'amap:C', name: '武康庭', ...mid });
  const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, b, c]]),
    pace: 'balanced',
  });

  assert.equal(search.calls.length, 2);
  assert.deepEqual(
    enriched.days[0].routes.map((route) => [route.fromPlaceId, route.toPlaceId]),
    [
      ['amap:A', 'amap:B'],
      ['amap:B', 'amap:C'],
    ],
  );
  assert.equal(enriched.days[0].unresolvedRoutes.length, 0);
  assert.deepEqual(
    enriched.days[0].stops.map((item) => item.place.id),
    ['amap:A', 'amap:B', 'amap:C'],
  );
});

test('plans adjacent routes in the same order as the time-sorted timeline', async () => {
  const morning = place({ id: 'amap:AM', name: '景山公园', ...origin });
  const afternoon = place({ id: 'amap:PM', name: '国家博物馆', ...near });
  const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
  const enricher = new AmapTripRouteEnricher(search);
  const plan: ResolvedTripPlanSuggestion = {
    title: '北京 1 日',
    summary: '按访问时间安排。',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '第一日',
      summary: '上午补充，下午保留原地点。',
      stops: [
        {
          ...stop(morning),
          suggestedStartTime: '10:00',
          resolutionSource: 'DAY_FALLBACK_MATCH',
        },
        {
          ...stop(afternoon),
          suggestedStartTime: '16:00',
          resolutionSource: 'PRIMARY_MATCH',
        },
      ],
    }],
  };

  const enriched = await enricher.enrich({ plan, pace: 'balanced' });

  assert.deepEqual(
    enriched.days[0].stops.map((item) => item.place.id),
    ['amap:AM', 'amap:PM'],
  );
  assert.deepEqual(
    enriched.days[0].routes.map((route) => [route.fromPlaceId, route.toPlaceId]),
    [['amap:AM', 'amap:PM']],
  );
  assert.equal(search.calls[0]?.origin.latitude, morning.latitude);
  assert.equal(search.calls[0]?.destination.latitude, afternoon.latitude);
});

test('does not plan routes across days', async () => {
  const day1a = place({ id: 'amap:D1A', name: '外滩', ...origin });
  const day1b = place({ id: 'amap:D1B', name: '南京路', ...near });
  const day2a = place({ id: 'amap:D2A', name: '豫园', ...mid });
  const day2b = place({ id: 'amap:D2B', name: '城隍庙', ...far });
  const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[day1a, day1b], [day2a, day2b]]),
    pace: 'balanced',
  });

  assert.equal(search.calls.length, 2);
  assert.deepEqual(
    search.calls.map((call) => [call.origin, call.destination]),
    [
      [{ latitude: day1a.latitude, longitude: day1a.longitude }, { latitude: day1b.latitude, longitude: day1b.longitude }],
      [{ latitude: day2a.latitude, longitude: day2a.longitude }, { latitude: day2b.latitude, longitude: day2b.longitude }],
    ],
  );
  assert.equal(enriched.days[0].routes.length, 1);
  assert.equal(enriched.days[1].routes.length, 1);
  assert.equal(enriched.days[0].routes[0].fromPlaceId, 'amap:D1A');
  assert.equal(enriched.days[0].routes[0].toPlaceId, 'amap:D1B');
  assert.equal(enriched.days[1].routes[0].fromPlaceId, 'amap:D2A');
  assert.equal(enriched.days[1].routes[0].toPlaceId, 'amap:D2B');
});

test('does not call the route service for days with fewer than two stops', async () => {
  const search = new FakeRouteService(async () => {
    throw new Error('should not plan');
  });
  const enricher = new AmapTripRouteEnricher(search);
  const emptyDay = place({ id: 'amap:ONLY', name: '武康路', ...origin });

  const enriched = await enricher.enrich({
    plan: {
      title: '上海一日',
      summary: '轻松漫步。',
      days: [
        { dayNumber: 1, title: '第1日', summary: '休整', stops: [] },
        { dayNumber: 2, title: '第2日', summary: '单点', stops: [stop(emptyDay)] },
      ],
      unresolved: [
        { dayNumber: 1, name: '未匹配店', query: '未匹配店', reason: 'NO_MATCH' },
      ],
    },
    pace: 'balanced',
  });

  assert.equal(search.calls.length, 0);
  assert.deepEqual(enriched.days[0].routes, []);
  assert.deepEqual(enriched.days[1].routes, []);
  assert.equal(enriched.unresolved.length, 1);
});

test('selects walk or taxi from Haversine distance and pace thresholds', async () => {
  assert.equal(selectTransportMode(2_000, 'relaxed'), 'walk');
  assert.equal(selectTransportMode(2_000.1, 'relaxed'), 'taxi');
  assert.equal(selectTransportMode(1_500, 'balanced'), 'walk');
  assert.equal(selectTransportMode(1_500, undefined), 'walk');
  assert.equal(selectTransportMode(1_000, 'packed'), 'walk');
  const cases: Array<{
    pace?: TripPace;
    meters: number;
    mode: 'walk' | 'taxi';
  }> = [
    { pace: 'relaxed', meters: 1_990, mode: 'walk' },
    { pace: 'relaxed', meters: 2_010, mode: 'taxi' },
    { pace: 'balanced', meters: 1_490, mode: 'walk' },
    { pace: 'balanced', meters: 1_510, mode: 'taxi' },
    { pace: 'packed', meters: 990, mode: 'walk' },
    { pace: 'packed', meters: 1_010, mode: 'taxi' },
    { pace: undefined, meters: 1_490, mode: 'walk' },
    { pace: undefined, meters: 1_510, mode: 'taxi' },
  ];

  for (const item of cases) {
    const from = place({ id: `amap:FROM-${item.pace ?? 'default'}-${item.meters}`, name: '起点', ...origin });
    const toPoint = pointNorthOf(origin, item.meters);
    const to = place({ id: `amap:TO-${item.pace ?? 'default'}-${item.meters}`, name: '终点', ...toPoint });
    const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
    const enricher = new AmapTripRouteEnricher(search);
    const input = { plan: resolvedPlan([[from, to]]), pace: item.pace };

    const enriched = await enricher.enrich(input);

    assert.equal(selectTransportMode(haversineMeters(origin, toPoint), item.pace), item.mode);
    assert.equal(search.calls[0].mode, item.mode);
    assert.equal(enriched.days[0].routes[0].transport.mode, item.mode);
    assert.notEqual(enriched.days[0].routes[0].transport.distanceMeters, item.meters);
  }
});

test('passes origin and destination as latitude/longitude GeoPoints in stop order', async () => {
  const from = place({ id: 'amap:FROM', name: '起点', latitude: 31.2304, longitude: 121.4737 });
  const to = place({ id: 'amap:TO', name: '终点', latitude: 31.2404, longitude: 121.4837 });
  const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
  const enricher = new AmapTripRouteEnricher(search);

  await enricher.enrich({
    plan: resolvedPlan([[from, to]]),
    pace: 'packed',
  });

  assert.deepEqual(search.calls[0].origin, { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(search.calls[0].destination, { latitude: 31.2404, longitude: 121.4837 });
  assert.equal('lng' in (search.calls[0].origin as object), false);
});

test('copies transport and polyline from the route service without sharing references', async () => {
  const from = place({ id: 'amap:FROM', name: '起点', ...origin });
  const to = place({ id: 'amap:TO', name: '终点', ...near });
  const serviceRoute: RouteResult = {
    transport: {
      mode: 'walk',
      distanceMeters: 880,
      durationMinutes: 11,
      description: '步行前往下站',
    },
    polyline: [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.235, longitude: 121.472 },
    ],
  };
  const originalRoute = structuredClone(serviceRoute);
  const search = new FakeRouteService(async () => serviceRoute);
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[from, to]]),
    pace: 'balanced',
  });

  const route = enriched.days[0].routes[0];
  assert.deepEqual(route.transport, originalRoute.transport);
  assert.deepEqual(route.polyline, originalRoute.polyline);
  route.transport.distanceMeters = 1;
  route.polyline[0].latitude = 0;
  serviceRoute.transport.durationMinutes = 99;
  serviceRoute.polyline[1].longitude = 0;
  assert.deepEqual(originalRoute.transport.distanceMeters, 880);
  assert.equal(enriched.days[0].routes[0].transport.durationMinutes, 11);
  assert.equal(enriched.days[0].routes[0].polyline[1].longitude, 121.472);
});

test('skips illegal coordinates without calling the route service and continues later pairs', async () => {
  const a = place({ id: 'amap:A', name: '合法甲', ...origin });
  const bad = place({ id: 'amap:BAD', name: '非法点', latitude: 91, longitude: 121.47 });
  const c = place({ id: 'amap:C', name: '合法乙', ...near });
  const d = place({ id: 'amap:D', name: '合法丙', ...mid });
  const search = new FakeRouteService(async (input) => routeResult(input.mode, input.origin, input.destination));
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, bad, c, d]]),
    pace: 'balanced',
  });

  assert.equal(search.calls.length, 1);
  assert.deepEqual(search.calls[0].origin, { latitude: c.latitude, longitude: c.longitude });
  assert.deepEqual(search.calls[0].destination, { latitude: d.latitude, longitude: d.longitude });
  assert.deepEqual(enriched.days[0].unresolvedRoutes, [
    { fromPlaceId: 'amap:A', toPlaceId: 'amap:BAD', reason: 'MISSING_COORDINATES' },
    { fromPlaceId: 'amap:BAD', toPlaceId: 'amap:C', reason: 'MISSING_COORDINATES' },
  ]);
  assert.equal(enriched.days[0].routes.length, 1);
  assert.equal(enriched.days[0].routes[0].fromPlaceId, 'amap:C');
});

test('maps a single provider failure to ROUTE_UNAVAILABLE and continues', async () => {
  const a = place({ id: 'amap:A', name: '甲', ...origin });
  const b = place({ id: 'amap:B', name: '乙', ...near });
  const c = place({ id: 'amap:C', name: '丙', ...mid });
  const search = new FakeRouteService(async (input) => {
    if (input.origin.latitude === a.latitude) {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com key=leak');
    }
    return routeResult(input.mode, input.origin, input.destination);
  });
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, b, c]]),
    pace: 'balanced',
  });

  assert.equal(search.calls.length, 2);
  assert.deepEqual(enriched.days[0].unresolvedRoutes, [
    { fromPlaceId: 'amap:A', toPlaceId: 'amap:B', reason: 'ROUTE_UNAVAILABLE' },
  ]);
  assert.equal(enriched.days[0].routes.length, 1);
  assert.equal(enriched.days[0].routes[0].fromPlaceId, 'amap:B');
  assert.equal(JSON.stringify(enriched).includes('amap.com'), false);
  assert.equal(JSON.stringify(enriched).includes('key='), false);
});

test('rejects an invalid route result without emitting a partial route', async () => {
  const a = place({ id: 'amap:A', name: '甲', ...origin });
  const b = place({ id: 'amap:B', name: '乙', ...near });
  const c = place({ id: 'amap:C', name: '丙', ...mid });
  const search = new FakeRouteService(async (input) => {
    if (input.origin.latitude === a.latitude) {
      return {
        transport: { mode: 'walk', distanceMeters: Number.NaN, durationMinutes: 12 },
        polyline: [input.origin],
      };
    }
    return routeResult(input.mode, input.origin, input.destination);
  });
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, b, c]]),
    pace: 'balanced',
  });

  assert.deepEqual(enriched.days[0].unresolvedRoutes, [
    { fromPlaceId: 'amap:A', toPlaceId: 'amap:B', reason: 'INVALID_ROUTE_RESULT' },
  ]);
  assert.equal(enriched.days[0].routes.length, 1);
  assert.equal(enriched.days[0].routes[0].fromPlaceId, 'amap:B');
});

test('throws INVALID_REQUEST before any route call for illegal input', async () => {
  const valid = place({ id: 'amap:A', name: '甲', ...origin });
  const other = place({ id: 'amap:B', name: '乙', ...near });
  const search = new FakeRouteService(async () => {
    throw new Error('should not plan');
  });
  const enricher = new AmapTripRouteEnricher(search);
  const base = resolvedPlan([[valid, other]]);

  const cases: EnrichmentCase[] = [
    { plan: { ...base, days: [{ ...base.days[0], dayNumber: 2 }] }, pace: 'balanced' },
    { plan: resolvedPlan([[place({ id: '  ', name: '空编号', ...origin }), other]]), pace: 'balanced' },
    { plan: resolvedPlan([[valid, valid]]), pace: 'balanced' },
    { plan: base, pace: 'fast' as TripPace },
    {
      plan: {
        ...base,
        days: [{ ...base.days[0], stops: [{ ...base.days[0].stops[0], place: undefined as never }] }],
      },
      pace: 'balanced',
    },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => enricher.enrich(input),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.message, '行程路线编排请求无效，请调整后重试。');
        return true;
      },
    );
  }
  assert.equal(search.calls.length, 0);
});

type EnrichmentCase = {
  plan: ResolvedTripPlanSuggestion;
  pace?: TripPace;
};

test('caps concurrent route calls and keeps itinerary order', async () => {
  const places = [
    place({ id: 'amap:1', name: '一', ...origin }),
    place({ id: 'amap:2', name: '二', ...near }),
    place({ id: 'amap:3', name: '三', ...mid }),
    place({ id: 'amap:4', name: '四', ...pointNorthOf(origin, 3_000) }),
    place({ id: 'amap:5', name: '五', ...pointNorthOf(origin, 4_000) }),
  ];
  const completed: string[] = [];
  const search = new FakeRouteService(async (input) => {
    const fromId = input.origin.latitude === places[0].latitude
      ? 'amap:1'
      : input.origin.latitude === places[1].latitude
        ? 'amap:2'
        : input.origin.latitude === places[2].latitude
          ? 'amap:3'
          : 'amap:4';
    await delay(fromId === 'amap:1' ? 40 : 5);
    completed.push(fromId);
    return routeResult(input.mode, input.origin, input.destination);
  });
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([places]),
    pace: 'relaxed',
  });

  assert.ok(search.maxInFlight <= TRIP_ROUTE_ENRICH_CONCURRENCY);
  assert.equal(search.maxInFlight, TRIP_ROUTE_ENRICH_CONCURRENCY);
  assert.deepEqual(
    enriched.days[0].routes.map((route) => route.fromPlaceId),
    ['amap:1', 'amap:2', 'amap:3', 'amap:4'],
  );
  assert.ok(completed.indexOf('amap:1') > completed.indexOf('amap:2'));
});

test('does not mutate the resolved plan, places, or route service result', async () => {
  const from = place({ id: 'amap:FROM', name: '起点', ...origin });
  const to = place({ id: 'amap:TO', name: '终点', ...near });
  const plan = resolvedPlan([[from, to]], [
    { dayNumber: 1, name: '漏网', query: '漏网', reason: 'NO_MATCH' },
  ]);
  const originalPlan = structuredClone(plan);
  const serviceRoute = routeResult('walk', { ...origin }, { ...near });
  const originalRoute = structuredClone(serviceRoute);
  Object.freeze(plan);
  Object.freeze(plan.days);
  Object.freeze(plan.days[0]);
  Object.freeze(plan.days[0].stops);
  Object.freeze(from);
  Object.freeze(to);
  const search = new FakeRouteService(async (input) => {
    Object.freeze(input);
    return serviceRoute;
  });
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({ plan, pace: 'balanced' });
  enriched.days[0].stops[0].place.name = '被改写';
  enriched.days[0].routes[0].polyline[0].latitude = 0;
  serviceRoute.polyline[0].longitude = 0;

  assert.deepEqual(plan, originalPlan);
  assert.equal(from.name, '起点');
  assert.deepEqual(originalRoute.polyline[0], origin);
  assert.equal(enriched.unresolved[0].reason, 'NO_MATCH');
});

test('returns empty routes and complete unresolvedRoutes when every pair fails', async () => {
  const a = place({ id: 'amap:A', name: '甲', ...origin });
  const b = place({ id: 'amap:B', name: '乙', ...near });
  const search = new FakeRouteService(async () => {
    throw new AmapProviderError('PROVIDER_UNAVAILABLE', 'ECONNRESET stack');
  });
  const enricher = new AmapTripRouteEnricher(search);

  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, b]]),
    pace: 'balanced',
  });

  assert.deepEqual(enriched.days[0].routes, []);
  assert.deepEqual(enriched.days[0].unresolvedRoutes, [
    { fromPlaceId: 'amap:A', toPlaceId: 'amap:B', reason: 'ROUTE_UNAVAILABLE' },
  ]);
  assert.equal('id' in enriched, false);
});

test('route budget timeout aborts remaining requests and does not invent routes', async () => {
  const a = place({ id: 'amap:A', name: '甲', ...origin });
  const b = place({ id: 'amap:B', name: '乙', ...near });
  const c = place({ id: 'amap:C', name: '丙', ...mid });
  let aborted = 0;
  const search = new FakeRouteService(async (input): Promise<RouteResult> => {
    await new Promise<never>((_resolve, reject) => {
      const fail = () => {
        aborted += 1;
        reject(new AmapProviderError('PROVIDER_ERROR', 'aborted'));
      };
      if (input.signal?.aborted) {
        fail();
        return;
      }
      input.signal?.addEventListener('abort', fail, { once: true });
    });
    throw new Error('unreachable');
  });
  const enricher = new AmapTripRouteEnricher(search);
  const enriched = await enricher.enrich({
    plan: resolvedPlan([[a, b, c]]),
    pace: 'balanced',
    budgetMs: 20,
  });
  assert.deepEqual(enriched.days[0].routes, []);
  assert.equal(enriched.days[0].unresolvedRoutes.length, 2);
  assert.ok(enriched.days[0].unresolvedRoutes.every((item) => item.reason === 'ROUTE_UNAVAILABLE'));
  assert.ok(aborted >= 1);
});

test('unknown failures become a stable provider error without leaking details', async () => {
  const a = place({ id: 'amap:A', name: '甲', ...origin });
  const b = place({ id: 'amap:B', name: '乙', ...near });
  const search = new FakeRouteService(async () => {
    throw new Error('TypeError at restapi.amap.com key=secret');
  });
  const enricher = new AmapTripRouteEnricher(search);

  await assert.rejects(
    () => enricher.enrich({ plan: resolvedPlan([[a, b]]), pace: 'balanced' }),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, '路线服务暂时不可用，请稍后重试。');
      assert.equal(String(error.message).includes('amap.com'), false);
      return true;
    },
  );
});
