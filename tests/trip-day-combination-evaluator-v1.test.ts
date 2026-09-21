import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateDayCombinationV1,
  shadowEvaluateGeneratedDayCombinationsV1,
} from '../server/services/trip-day-combination-evaluator-v1';
import type { Place, Trip, TripDay, TripPlace, TripRoute } from '../src/domain/trip/types';

function catalogPlace(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
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

function tripPlace(overrides: Partial<TripPlace> & Pick<TripPlace, 'id' | 'placeId' | 'placeName' | 'type'>): TripPlace {
  return {
    dayId: 'day-1',
    order: 1,
    estimatedCost: 0,
    durationMinutes: 90,
    ...overrides,
  };
}

function day(places: TripPlace[], id = 'day-1'): TripDay {
  return {
    id,
    tripId: 'trip-1',
    dayNumber: 1,
    date: '2026-10-01',
    places,
  };
}

const museum = catalogPlace({ id: 'amap:NAT', name: '国家博物馆' });
const otherMuseum = catalogPlace({ id: 'amap:CAP', name: '首都博物馆' });
const thirdMuseum = catalogPlace({ id: 'amap:MIL', name: '军事博物馆' });
const park = catalogPlace({ id: 'amap:PARK', name: '景山公园' });
const palace = catalogPlace({ id: 'amap:PALACE', name: '故宫博物院' });
const hutong = catalogPlace({ id: 'amap:HUTONG', name: '南锣鼓巷', category: 'activity' });
const unnamed = catalogPlace({ id: 'amap:X', name: '示例地点甲' });
const hike = catalogPlace({ id: 'amap:HIKE', name: '香山徒步', category: 'activity' });

function core(place: Place, minutes: number, order: number): TripPlace {
  return tripPlace({
    id: `tp:${place.id}`,
    placeId: place.id,
    placeName: place.name,
    type: place.category,
    durationMinutes: minutes,
    order,
  });
}

const lowWalking = {
  partyContext: { partyType: 'parents' as const, hasElderly: true, mobilityRequirement: 'low_walking' as const },
  constraints: { excludedInterestKeys: [] as never[], lowWalking: true },
};

test('identical day combination inputs produce identical totals and breakdowns', () => {
  const input = {
    day: day([core(museum, 90, 1), core(park, 90, 2), core(palace, 90, 3)]),
    places: [museum, park, palace],
    policy: { targetCorePlacesPerDay: 3 as const },
  };
  assert.deepEqual(evaluateDayCombinationV1(input), evaluateDayCombinationV1(structuredClone(input)));
});

test('a low-walking two-core day scores full coverage', () => {
  const result = evaluateDayCombinationV1({
    day: day([core(palace, 90, 1), core(park, 90, 2)]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
    ...lowWalking,
  });
  assert.equal(result.breakdown.coreCoverage, 100);
});

test('a balanced three-core day scores full coverage', () => {
  const result = evaluateDayCombinationV1({
    day: day([core(museum, 90, 1), core(park, 90, 2), core(palace, 90, 3)]),
    places: [museum, park, palace],
    policy: { targetCorePlacesPerDay: 3 },
  });
  assert.equal(result.breakdown.coreCoverage, 100);
});

test('three same-group museums score lower diversity than mixed groups', () => {
  const same = evaluateDayCombinationV1({
    day: day([core(museum, 90, 1), core(otherMuseum, 90, 2), core(thirdMuseum, 90, 3)]),
    places: [museum, otherMuseum, thirdMuseum],
    policy: { targetCorePlacesPerDay: 3 },
  });
  const mixed = evaluateDayCombinationV1({
    day: day([core(museum, 90, 1), core(park, 90, 2), core(palace, 90, 3)]),
    places: [museum, park, palace],
    policy: { targetCorePlacesPerDay: 3 },
  });
  assert.ok(same.breakdown.diversity < mixed.breakdown.diversity);
  assert.equal(same.breakdown.diversity, 50);
  assert.equal(mixed.breakdown.diversity, 100);
});

test('all unknown groups stay at a neutral diversity score', () => {
  const result = evaluateDayCombinationV1({
    day: day([core(unnamed, 90, 1), core({ ...unnamed, id: 'amap:Y', name: '示例地点乙' }, 90, 2)]),
    places: [unnamed, { ...unnamed, id: 'amap:Y', name: '示例地点乙' }],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(result.breakdown.diversity, 50);
});

test('low-walking high-burden long days score lower fatigue than a light mix', () => {
  const heavy = evaluateDayCombinationV1({
    day: day([core(hutong, 150, 1), core(hike, 150, 2)]),
    places: [hutong, hike],
    policy: { targetCorePlacesPerDay: 2 },
    ...lowWalking,
  });
  const light = evaluateDayCombinationV1({
    day: day([core(palace, 90, 1), core(park, 90, 2)]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
    ...lowWalking,
  });
  assert.ok(heavy.breakdown.fatigueRhythm < light.breakdown.fatigueRhythm);
});

test('missing real routes stay at a neutral efficiency score', () => {
  const result = evaluateDayCombinationV1({
    day: day([core(palace, 90, 1), core(park, 90, 2)]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
    routes: [],
  });
  assert.equal(result.breakdown.routeEfficiency, 50);
});

test('existing route durations map onto the documented buckets', () => {
  const route = (minutes: number): TripRoute => ({
    id: `route:${minutes}`,
    dayId: 'day-1',
    fromTripPlaceId: 'tp:a',
    toTripPlaceId: 'tp:b',
    transport: { mode: 'metro', durationMinutes: minutes, distanceMeters: 1000 },
  });
  const scored = (minutes: number) => evaluateDayCombinationV1({
    day: day([core(palace, 90, 1), core(park, 90, 2)]),
    places: [palace, park],
    routes: [route(minutes)],
  }).breakdown.routeEfficiency;
  assert.equal(scored(45), 100);
  assert.equal(scored(90), 80);
  assert.equal(scored(150), 55);
  assert.equal(scored(151), 25);
});

test('shadow evaluation swallows evaluator errors and does not attach scores', () => {
  const trip: Trip = {
    id: 'trip-1',
    userId: 'user-1',
    title: '北京',
    destination: '北京',
    travelerCount: 2,
    totalBudget: 0,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: [] },
    status: 'PLANNING',
    days: [day([core(palace, 90, 1)])],
    routes: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
  const before = structuredClone(trip);
  assert.doesNotThrow(() => {
    shadowEvaluateGeneratedDayCombinationsV1({
      trip,
      places: [palace],
      evaluate: () => {
        throw new Error('combination failed');
      },
    });
  });
  assert.deepEqual(trip, before);
  assert.equal(JSON.stringify(trip).includes('coreCoverage'), false);
});

test('combination score types stay off trip API and display surfaces', () => {
  const roots = [
    readFileSync(join(process.cwd(), 'src/services/trip-display.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/services/bff-trip-generation-service.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'server/routes/trip-generate.ts'), 'utf8'),
  ].join('\n');
  assert.equal(roots.includes('DayCombinationScoreV1'), false);
  assert.equal(roots.includes('shadowEvaluateGeneratedDayCombinationsV1'), false);
});
