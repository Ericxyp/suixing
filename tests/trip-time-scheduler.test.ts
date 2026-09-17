import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmedTripBuilder } from '../server/services/trip-builder';
import type { ConfirmedTripRequirement } from '../server/services/trip-plan-generator';
import type { ResolvedTripPlaceStop } from '../server/services/trip-place-resolver';
import type {
  EnrichedTripRoute,
  RouteEnrichedTripPlanSuggestion,
} from '../server/services/trip-route-enricher';
import {
  DEFAULT_DAY_START_MINUTES,
  MISSING_ROUTE_SCHEDULE_BUFFER_MINUTES,
  TRANSFER_BUFFER_MINUTES,
  TRIP_TIME_SCHEDULE_INVALID_REQUEST_MESSAGE,
  TripTimeScheduleError,
  ceilToScheduleStep,
  formatClockMinutes,
  parseClockMinutes,
  scheduleEnrichedTripTimes,
} from '../server/services/trip-time-scheduler';
import type { GeoPoint, Place } from '../src/domain/trip/types';

function geo(latitude: number, longitude: number): GeoPoint {
  return { latitude, longitude };
}

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '北京市东城区示例路 1 号',
    latitude: 39.9,
    longitude: 116.4,
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
    reason: '城市核心地点。',
    sourceQuery: resolvedPlace.name,
    ...extras,
  };
}

function routeBetween(
  from: Place,
  to: Place,
  durationMinutes = 12,
): EnrichedTripRoute {
  return {
    fromPlaceId: from.id,
    toPlaceId: to.id,
    transport: {
      mode: 'taxi',
      distanceMeters: 4200,
      durationMinutes,
      description: '打车前往下站',
    },
    polyline: [
      geo(from.latitude, from.longitude),
      geo(to.latitude, to.longitude),
    ],
  };
}

const museum = place({ id: 'amap:NMC', name: '中国国家博物馆' });
const water = place({ id: 'amap:WATER', name: '国家游泳中心' });
const park = place({ id: 'amap:PARK', name: '景山公园' });

function dayPlan(
  stops: ResolvedTripPlaceStop[],
  routes: EnrichedTripRoute[],
): RouteEnrichedTripPlanSuggestion {
  return {
    title: '北京 1 天',
    summary: '测试排程。',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '城区',
      summary: '连续访问。',
      stops,
      routes,
      unresolvedRoutes: [],
    }],
  };
}

test('moves a late first-stop suggestion to 10:00', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [stop(museum, { suggestedStartTime: '16:00' }), stop(water, { suggestedStartTime: '19:30' })],
    [routeBetween(museum, water, 47)],
  ));
  assert.equal(scheduled.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(parseClockMinutes('10:00'), DEFAULT_DAY_START_MINUTES);
});

test('keeps a first-stop suggestion inside the morning window', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [stop(museum, { suggestedStartTime: '10:30' }), stop(water)],
    [routeBetween(museum, water, 47)],
  ));
  assert.equal(scheduled.days[0].stops[0].suggestedStartTime, '10:30');
});

test('next stop is not earlier than stay plus real transit plus transfer buffer', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 120 }),
      stop(water, { suggestedStartTime: '10:00' }),
    ],
    [routeBetween(museum, water, 47)],
  ));
  assert.equal(
    scheduled.days[0].stops[1].suggestedStartTime,
    formatClockMinutes(ceilToScheduleStep(10 * 60 + 120 + 47 + TRANSFER_BUFFER_MINUTES)),
  );
  assert.equal(scheduled.days[0].stops[1].suggestedStartTime, '13:05');
});

test('scheduler keeps already standardized stay duration unchanged', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 210 }),
      stop(park, { suggestedStartTime: '16:00', suggestedDurationMinutes: 120 }),
    ],
    [routeBetween(museum, park, 20)],
  ));
  assert.equal(scheduled.days[0].stops[0].suggestedDurationMinutes, 210);
  assert.equal(scheduled.days[0].stops[1].suggestedDurationMinutes, 120);
  assert.equal(scheduled.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(
    scheduled.days[0].stops[1].suggestedStartTime,
    formatClockMinutes(ceilToScheduleStep(10 * 60 + 210 + 20 + TRANSFER_BUFFER_MINUTES)),
  );
});

test('drops an AI gap larger than 90 minutes and uses the earliest reachable time', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 120 }),
      stop(water, { suggestedStartTime: '19:30' }),
    ],
    [routeBetween(museum, water, 47)],
  ));
  assert.equal(scheduled.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(scheduled.days[0].stops[1].suggestedStartTime, '13:05');
});

test('keeps a short AI rest gap of at most 90 minutes', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 120 }),
      stop(water, { suggestedStartTime: '14:00' }),
    ],
    [routeBetween(museum, water, 47)],
  ));
  assert.equal(scheduled.days[0].stops[1].suggestedStartTime, '14:00');
});

test('missing routes use an internal 30-minute buffer without forging transport', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 90 }),
      stop(water, { suggestedStartTime: '10:00' }),
    ],
    [],
  ));
  assert.equal(
    scheduled.days[0].stops[1].suggestedStartTime,
    formatClockMinutes(ceilToScheduleStep(
      10 * 60 + 90 + MISSING_ROUTE_SCHEDULE_BUFFER_MINUTES + TRANSFER_BUFFER_MINUTES,
    )),
  );
  assert.equal(scheduled.days[0].stops[1].suggestedStartTime, '12:15');
  assert.deepEqual(scheduled.days[0].routes, []);
  assert.equal(JSON.stringify(scheduled).includes('30 分钟'), false);
  assert.equal(JSON.stringify(scheduled).includes('换场'), false);
});

test('rounds computed times up to the next 5 minutes', () => {
  assert.equal(ceilToScheduleStep(13 * 60 + 2), 13 * 60 + 5);
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 88 }),
      stop(water, { suggestedStartTime: '10:00' }),
    ],
    [routeBetween(museum, water, 14)],
  ));
  assert.equal(
    scheduled.days[0].stops[1].suggestedStartTime,
    formatClockMinutes(ceilToScheduleStep(10 * 60 + 88 + 14 + TRANSFER_BUFFER_MINUTES)),
  );
  assert.equal(scheduled.days[0].stops[1].suggestedStartTime, '12:00');
});

test('schedules several stops continuously with legal clock times', () => {
  const scheduled = scheduleEnrichedTripTimes(dayPlan(
    [
      stop(museum, { suggestedStartTime: '09:00', suggestedDurationMinutes: 90 }),
      stop(park, { suggestedStartTime: '16:00', suggestedDurationMinutes: 60 }),
      stop(water, { suggestedStartTime: '19:30', suggestedDurationMinutes: 80 }),
    ],
    [routeBetween(museum, park, 20), routeBetween(park, water, 47)],
  ));
  assert.deepEqual(
    scheduled.days[0].stops.map((item) => item.suggestedStartTime),
    ['10:00', '12:05', '14:10'],
  );
  for (const item of scheduled.days[0].stops) {
    assert.match(item.suggestedStartTime, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
    assert.notEqual(item.suggestedStartTime, '24:00');
  }
});

test('does not mutate the input plan, places, routes or polylines', () => {
  const original = dayPlan(
    [
      stop(museum, { suggestedStartTime: '16:00', suggestedDurationMinutes: 120 }),
      stop(water, { suggestedStartTime: '19:30' }),
    ],
    [routeBetween(museum, water, 47)],
  );
  const frozen = structuredClone(original);
  const scheduled = scheduleEnrichedTripTimes(original);
  original.days[0].stops[0].suggestedStartTime = '00:00';
  original.days[0].routes[0].transport.durationMinutes = 1;
  original.days[0].routes[0].polyline[0].latitude = 0;
  museum.name = '被改名';
  assert.deepEqual(frozen.days[0].stops[0].suggestedStartTime, '16:00');
  assert.equal(scheduled.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(scheduled.days[0].stops[0].place.name, '中国国家博物馆');
  assert.equal(scheduled.days[0].routes[0].transport.durationMinutes, 47);
  assert.equal(scheduled.days[0].routes[0].polyline[0].latitude, 39.9);
  assert.notEqual(scheduled.days[0].stops[0], original.days[0].stops[0]);
  assert.notEqual(scheduled.days[0].routes[0].polyline, original.days[0].routes[0].polyline);
});

test('trip builder uses scheduled start times rather than raw AI suggestions', () => {
  const requirement: ConfirmedTripRequirement = {
    destination: '北京',
    startDate: '2026-10-01',
    endDate: '2026-10-01',
    durationDays: 1,
    travelerCount: 3,
    totalBudget: 3000,
  };
  const plan = dayPlan(
    [
      stop(museum, { suggestedStartTime: '16:00', suggestedDurationMinutes: 120 }),
      stop(water, { suggestedStartTime: '19:30' }),
    ],
    [routeBetween(museum, water, 47)],
  );
  const scheduled = scheduleEnrichedTripTimes(plan);
  const trip = new ConfirmedTripBuilder().build({
    requirement,
    plan: scheduled,
    tripId: 'trip-schedule-1',
    userId: 'user-demo-001',
    createdAt: '2026-09-16T00:00:00.000Z',
  }).trip;
  assert.equal(trip.days[0].places[0].startTime, '10:00');
  assert.equal(trip.days[0].places[1].startTime, '14:35');
  assert.equal(trip.days[0].places[0].durationMinutes, 120);
  assert.equal(trip.days[0].places[0].transportToNext?.durationMinutes, 47);
  assert.equal(trip.routes[0].transport.durationMinutes, 47);
  assert.equal(trip.days[0].places[0].order, 1);
  assert.equal(trip.days[0].places[1].order, 2);
  assert.equal(trip.routes[0].fromTripPlaceId, trip.days[0].places[0].id);
  assert.equal(trip.routes[0].toTripPlaceId, trip.days[0].places[1].id);
});

test('rejects a day that would schedule past 23:59 without building a partial plan', () => {
  assert.throws(
    () => scheduleEnrichedTripTimes(dayPlan(
      [
        stop(museum, { suggestedStartTime: '10:00', suggestedDurationMinutes: 720 }),
        stop(water, { suggestedStartTime: '10:00' }),
      ],
      [routeBetween(museum, water, 120)],
    )),
    (error: unknown) => {
      assert.ok(error instanceof TripTimeScheduleError);
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.message, TRIP_TIME_SCHEDULE_INVALID_REQUEST_MESSAGE);
      return true;
    },
  );
});
