import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfirmedTripBuilder,
  TRIP_BUILDER_INVALID_REQUEST_MESSAGE,
  TripBuilderError,
  addUtcCalendarDays,
  type BuildTripInput,
} from '../server/services/trip-builder';
import type { ConfirmedTripRequirement } from '../server/services/trip-plan-generator';
import type { ResolvedTripPlaceStop } from '../server/services/trip-place-resolver';
import type {
  EnrichedTripRoute,
  RouteEnrichedTripPlanSuggestion,
} from '../server/services/trip-route-enricher';
import type { GeoPoint, Place } from '../src/domain/trip/types';
import { getDefaultTripDayId, hasItinerary } from '../src/services/trip-display';
import {
  resolveTripMapRoutes,
  resolveTripMapStops,
  summarizeTripMapRoutes,
} from '../src/services/trip-map';
import { BffClientError } from '../src/services/bff-client';
import { parseTripGenerationPayload } from '../src/services/bff-trip-generation-service';

const builder = new ConfirmedTripBuilder();

const requirement: ConfirmedTripRequirement = {
  destination: '上海',
  origin: '北京',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  preferences: {
    interests: ['咖啡', '建筑'],
    avoid: ['夜店'],
  },
};

function geo(latitude: number, longitude: number): GeoPoint {
  return { latitude, longitude };
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
  extras: Partial<ResolvedTripPlaceStop> = {},
): ResolvedTripPlaceStop {
  return {
    place: resolvedPlace,
    category: 'sight',
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
    sourceQuery: `查询${resolvedPlace.name}`,
    ...extras,
  };
}

function routeBetween(from: Place, to: Place): EnrichedTripRoute {
  return {
    fromPlaceId: from.id,
    toPlaceId: to.id,
    transport: {
      mode: 'walk',
      distanceMeters: 850,
      durationMinutes: 12,
      description: '步行前往下站',
    },
    polyline: [
      geo(from.latitude, from.longitude),
      geo(to.latitude, to.longitude),
    ],
  };
}

function threeDayPlan(): RouteEnrichedTripPlanSuggestion {
  const d1a = place({ id: 'amap:D1A', name: '武康路', latitude: 31.2077, longitude: 121.4361 });
  const d1b = place({ id: 'amap:D1B', name: '安福路', latitude: 31.2141, longitude: 121.4451, category: 'cafe' });
  const d2a = place({ id: 'amap:D2A', name: '外滩', latitude: 31.2401, longitude: 121.4908 });
  const d2b = place({ id: 'amap:D2B', name: '豫园', latitude: 31.2272, longitude: 121.4928 });
  const d3a = place({ id: 'amap:D3A', name: '人民广场', latitude: 31.2306, longitude: 121.4737 });
  return {
    title: '杭州假标题 9 天游',
    summary: '这份摘要不会写入 Trip 根对象。',
    days: [
      {
        dayNumber: 1,
        title: '梧桐街区',
        summary: '少移动，多步行。',
        stops: [
          stop(d1a, { suggestedStartTime: '10:30', reason: '老洋房与梧桐街景。' }),
          stop(d1b, { category: 'coffee', suggestedStartTime: '12:20' }),
        ],
        routes: [routeBetween(d1a, d1b)],
        unresolvedRoutes: [],
      },
      {
        dayNumber: 2,
        title: '江畔',
        summary: '外滩到豫园。',
        stops: [stop(d2a), stop(d2b)],
        routes: [routeBetween(d2a, d2b)],
        unresolvedRoutes: [
          { fromPlaceId: 'amap:D2B', toPlaceId: 'amap:MISSING', reason: 'ROUTE_UNAVAILABLE' },
        ],
      },
      {
        dayNumber: 3,
        title: '返程前',
        summary: '只保留已解析地点。',
        stops: [stop(d3a)],
        routes: [],
        unresolvedRoutes: [],
      },
    ],
    unresolved: [
      { dayNumber: 3, name: '虚构店', query: '虚构店', reason: 'NO_MATCH' },
    ],
  };
}

function input(
  overrides: Partial<BuildTripInput> = {},
): BuildTripInput {
  return {
    requirement: structuredClone(requirement),
    plan: threeDayPlan(),
    tripId: 'trip-fixed-001',
    userId: 'user-demo-001',
    createdAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

test('builds a valid 3-day Trip from a complete requirement and enriched plan', () => {
  const result = builder.build(input());
  const trip = result.trip;

  assert.equal(trip.id, 'trip-fixed-001');
  assert.equal(trip.userId, 'user-demo-001');
  assert.equal(trip.createdAt, '2026-09-13T00:00:00.000Z');
  assert.equal(trip.updatedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(trip.status, 'PLANNING');
  assert.equal(trip.currency, 'CNY');
  assert.equal(trip.days.length, 3);
  assert.deepEqual(trip.days.map((day) => day.dayNumber), [1, 2, 3]);
  assert.equal(result.diagnostics.unresolvedPlacesCount, 1);
  assert.equal(result.diagnostics.unresolvedRoutesCount, 1);
  assert.deepEqual(
    result.places.map((place) => place.id),
    trip.days.flatMap((day) => day.places.map((item) => item.placeId))
      .filter((placeId, index, ids) => ids.indexOf(placeId) === index),
  );
  assert.equal('typecode' in result.places[0], false);
});

test('uses injected ids and timestamps without reading the system clock', () => {
  const source = builder.build.toString();
  assert.equal(source.includes('Date.now'), false);
  assert.equal(source.includes('randomUUID'), false);
  assert.equal(source.includes('Math.random'), false);

  const createdAt = '2026-01-15T08:30:00.000Z';
  const trip = builder.build(input({
    tripId: 'trip-clock-1',
    createdAt,
  })).trip;

  assert.equal(trip.createdAt, createdAt);
  assert.equal(trip.updatedAt, createdAt);
  assert.equal(trip.days[0].id, 'trip-clock-1:day:1');
  assert.equal(trip.days[0].places[0].id, 'trip-clock-1:day:1:stop:1');
  assert.equal(trip.routes[0].id, 'trip-clock-1:day:1:route:1');
});

test('keeps requirement destination, travelers, budget and pace over conflicting plan copy', () => {
  const trip = builder.build(input()).trip;
  assert.equal(trip.destination, '上海');
  assert.equal(trip.origin, '北京');
  assert.equal(trip.travelerCount, 2);
  assert.equal(trip.totalBudget, 5000);
  assert.equal(trip.pace, 'relaxed');
  assert.equal(trip.title, '杭州假标题 9 天游');
  assert.deepEqual(trip.preferences.interests, ['咖啡', '建筑']);
  assert.equal('summary' in trip, false);
});

test('falls back to a safe title when the plan title is blank or too long', () => {
  const plan = threeDayPlan();
  plan.title = '   ';
  assert.equal(builder.build(input({ plan })).trip.title, '上海 3 天游');

  const longTitle = threeDayPlan();
  longTitle.title = '测'.repeat(81);
  assert.equal(builder.build(input({ plan: longTitle })).trip.title, '上海 3 天游');
});

test('uses Place identity for stops and maps suggestion time onto itinerary fields', () => {
  const trip = builder.build(input()).trip;
  const first = trip.days[0].places[0];
  const second = trip.days[0].places[1];

  assert.equal(first.placeId, 'amap:D1A');
  assert.equal(first.placeName, '武康路');
  assert.equal(first.type, 'attraction');
  assert.equal(first.startTime, '10:30');
  assert.equal(first.durationMinutes, 90);
  assert.equal(first.description, '老洋房与梧桐街景。');
  assert.equal(first.estimatedCost, 0);
  assert.equal(first.order, 1);
  assert.equal(second.placeName, '安福路');
  assert.equal(second.type, 'cafe');
  assert.equal(second.placeName.includes('查询'), false);
  assert.equal(trip.days[0].date, '2026-10-01');
  assert.equal(trip.days[1].date, '2026-10-02');
  assert.equal(trip.days[2].date, '2026-10-03');
  assert.equal(addUtcCalendarDays('2026-10-01', 2), '2026-10-03');
});

test('writes standardized stay duration onto TripPlace without exposing decision source', () => {
  const plan = threeDayPlan();
  plan.days[0].stops[0] = {
    ...plan.days[0].stops[0],
    suggestedDurationMinutes: 210,
    place: {
      ...plan.days[0].stops[0].place,
      name: '中国国家博物馆',
    },
  };
  const trip = builder.build(input({ plan })).trip;
  assert.equal(trip.days[0].places[0].durationMinutes, 210);
  assert.equal('source' in trip.days[0].places[0], false);
  assert.equal('reason' in trip.days[0].places[0], false);
  assert.equal(JSON.stringify(trip).includes('PLACE_NAME_RULE'), false);
});

test('maps only successful routes onto TripRoute and transportToNext', () => {
  const trip = builder.build(input()).trip;
  assert.equal(trip.routes.length, 2);
  assert.equal(trip.routes[0].fromTripPlaceId, trip.days[0].places[0].id);
  assert.equal(trip.routes[0].toTripPlaceId, trip.days[0].places[1].id);
  assert.equal(trip.routes[0].dayId, trip.days[0].id);
  assert.deepEqual(trip.routes[0].transport, {
    mode: 'walk',
    distanceMeters: 850,
    durationMinutes: 12,
    description: '步行前往下站',
  });
  assert.equal(trip.days[0].places[0].transportToNext?.mode, 'walk');
  assert.equal(trip.days[1].places[1].transportToNext, undefined);
  assert.equal(JSON.stringify(trip).includes('ROUTE_UNAVAILABLE'), false);
  assert.equal(JSON.stringify(trip).includes('虚构店'), false);
});

test('keeps empty-stop days and can build a trip with no successful routes', () => {
  const plan: RouteEnrichedTripPlanSuggestion = {
    title: '上海 2 天游',
    summary: '地点待补。',
    days: [
      {
        dayNumber: 1,
        title: '第1日',
        summary: '暂无已解析地点。',
        stops: [],
        routes: [],
        unresolvedRoutes: [
          { fromPlaceId: 'amap:A', toPlaceId: 'amap:B', reason: 'MISSING_COORDINATES' },
        ],
      },
      {
        dayNumber: 2,
        title: '第2日',
        summary: '仅一处地点。',
        stops: [stop(place({ id: 'amap:ONLY', name: '武康路' }))],
        routes: [],
        unresolvedRoutes: [],
      },
    ],
    unresolved: [
      { dayNumber: 1, name: '甲', query: '甲', reason: 'NO_MATCH' },
      { dayNumber: 1, name: '乙', query: '乙', reason: 'SEARCH_UNAVAILABLE' },
    ],
  };
  const result = builder.build(input({
    requirement: {
      destination: '上海',
      durationDays: 2,
      travelerCount: 1,
      totalBudget: 1000,
    },
    plan,
  }));

  assert.equal(result.trip.days.length, 2);
  assert.deepEqual(result.trip.days[0].places, []);
  assert.equal(result.trip.days[1].places.length, 1);
  assert.deepEqual(result.trip.routes, []);
  assert.equal(result.trip.days[0].date, '');
  assert.equal(result.trip.startDate, undefined);
  assert.equal(result.trip.pace, 'balanced');
  assert.equal(result.diagnostics.unresolvedPlacesCount, 2);
  assert.equal(result.diagnostics.unresolvedRoutesCount, 1);
  assert.equal(hasItinerary(result.trip), true);
});

test('satisfies workspace and map field consumption', () => {
  const plan = threeDayPlan();
  const trip = builder.build(input({ plan })).trip;
  const places = plan.days.flatMap((day) => day.stops.map((item) => item.place));

  assert.equal(getDefaultTripDayId(trip), trip.days[0].id);
  const stops = resolveTripMapStops(trip.days[0], places);
  assert.deepEqual(
    stops.map((item) => item.name),
    ['武康路', '安福路'],
  );
  assert.deepEqual(stops[0].position, { latitude: 31.2077, longitude: 121.4361 });
  const routes = resolveTripMapRoutes(trip, trip.days[0].id);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].fromTripPlaceId, trip.days[0].places[0].id);
  const summary = summarizeTripMapRoutes(routes);
  assert.equal(summary.routeCount, 1);
  assert.equal(summary.totalDistanceMeters, 850);
  assert.equal(summary.totalDurationMinutes, 12);
  assert.ok((trip.days[0].scheduleItems?.length ?? 0) >= 2);
  assert.equal(trip.days[0].scheduleItems?.some((item) => item.kind === 'experience'), false);
  assert.equal(JSON.stringify(trip).includes('自由活动'), false);
  assert.equal(
    resolveTripMapStops(trip.days[0], places).length,
    trip.days[0].places.length,
  );
  assert.equal(
    JSON.stringify(trip).includes('DensityPlanReason'),
    false,
  );
});

test('rejects illegal builder input before emitting a trip', () => {
  const cases: BuildTripInput[] = [
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => ({
          ...day,
          dayNumber: index === 1 ? 3 : day.dayNumber,
        })),
      },
    }),
    input({
      requirement: { ...requirement, durationDays: 2 },
    }),
    input({
      requirement: { ...requirement, startDate: '2026-10-01', endDate: '2026-10-10' },
    }),
    input({
      requirement: { ...requirement, endDate: '2026-09-01' },
    }),
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => (
          index === 0
            ? { ...day, stops: [{ ...day.stops[0], place: { ...day.stops[0].place, id: '  ' } }, day.stops[1]] }
            : day
        )),
      },
    }),
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => (
          index === 0
            ? { ...day, stops: [day.stops[0], { ...day.stops[1], place: { ...day.stops[0].place } }] }
            : day
        )),
      },
    }),
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => (
          index === 0
            ? {
                ...day,
                routes: [{
                  ...day.routes[0],
                  toPlaceId: 'amap:NOT-IN-DAY',
                }],
              }
            : day
        )),
      },
    }),
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => (
          index === 0
            ? {
                ...day,
                routes: [{
                  ...day.routes[0],
                  transport: { mode: 'walk', distanceMeters: Number.NaN, durationMinutes: 12 },
                }],
              }
            : day
        )),
      },
    }),
    input({
      plan: {
        ...threeDayPlan(),
        days: threeDayPlan().days.map((day, index) => (
          index === 0
            ? {
                ...day,
                routes: [{
                  ...day.routes[0],
                  polyline: [geo(31.2, 121.4)],
                }],
              }
            : day
        )),
      },
    }),
    input({ tripId: '' }),
    input({ createdAt: '2026-10-01' }),
    input({ createdAt: 'not-iso' }),
  ];

  for (const item of cases) {
    assert.throws(
      () => builder.build(item),
      (error: unknown) => {
        assert.ok(error instanceof TripBuilderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.message, TRIP_BUILDER_INVALID_REQUEST_MESSAGE);
        return true;
      },
    );
  }
});

test('does not mutate requirement, plan, places, routes or polylines', () => {
  const plan = threeDayPlan();
  const originalPlan = structuredClone(plan);
  const originalRequirement = structuredClone(requirement);
  const originalPolyline = structuredClone(plan.days[0].routes[0].polyline);
  Object.freeze(plan);
  Object.freeze(plan.days);
  Object.freeze(requirement);

  const result = builder.build(input({ requirement, plan }));
  assert.deepEqual(plan, originalPlan);
  assert.deepEqual(requirement, originalRequirement);

  result.trip.title = '被改写';
  result.trip.days[0].places[0].placeName = '被改写';
  result.trip.routes[0].polyline![0].latitude = 0;

  assert.deepEqual(plan, originalPlan);
  assert.equal(plan.days[0].routes[0].polyline[0].latitude, 31.2077);
  assert.deepEqual(originalPolyline[0], geo(31.2077, 121.4361));
  assert.equal(result.trip.days[0].places[0].placeId, 'amap:D1A');
});

test('builder days without startDate stay parseable by the BFF trip payload reader', () => {
  const { trip, places, diagnostics } = builder.build(input({
    requirement: {
      destination: '北京',
      durationDays: 3,
      travelerCount: 3,
      totalBudget: 3000,
      pace: 'balanced',
      preferences: { interests: ['历史建筑', '咖啡'] },
    },
  }));
  assert.equal(trip.days[0].date, '');
  const parsed = parseTripGenerationPayload({
    data: { trip, places, diagnostics },
  });
  assert.equal(parsed.trip.days[0].date, '');
  assert.equal(parsed.trip.destination, '北京');
  assert.equal(parsed.places[0].id, trip.days[0].places[0].placeId);
  assert.throws(
    () => parseTripGenerationPayload({
      data: {
        trip: {
          ...trip,
          days: trip.days.map((day, index) => (
            index === 0 ? { ...day, date: 1 } : day
          )),
        },
        places,
        diagnostics,
      },
    }),
    (error: unknown) => error instanceof BffClientError && error.code === 'INVALID_RESPONSE',
  );
});
