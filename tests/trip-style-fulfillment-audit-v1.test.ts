import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateStyleFulfillmentAuditV1,
  shadowEvaluateGeneratedTripStyleFulfillmentV1,
} from '../server/services/trip-style-fulfillment-audit-v1';
import type { Place, Trip, TripDay, TripPlace, TripScheduleItem } from '../src/domain/trip/types';

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

function tripPlace(
  overrides: Partial<TripPlace> & Pick<TripPlace, 'id' | 'placeId' | 'placeName' | 'type'>,
): TripPlace {
  return {
    dayId: 'day-1',
    order: 1,
    estimatedCost: 0,
    durationMinutes: 90,
    ...overrides,
  };
}

function day(places: TripPlace[], scheduleItems?: TripScheduleItem[], dayNumber = 1): TripDay {
  return {
    id: `day-${dayNumber}`,
    tripId: 'trip-1',
    dayNumber,
    date: `2026-10-0${dayNumber}`,
    places: places.map((place, index) => ({
      ...place,
      dayId: `day-${dayNumber}`,
      order: index + 1,
    })),
    scheduleItems,
  };
}

function trip(days: TripDay[], overrides: Partial<Trip> = {}): Trip {
  return {
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
    days,
    routes: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

const palace = catalogPlace({ id: 'amap:PALACE', name: '故宫博物院' });
const park = catalogPlace({ id: 'amap:PARK', name: '景山公园' });
const museum = catalogPlace({ id: 'amap:NAT', name: '国家博物馆' });
const mall = catalogPlace({ id: 'amap:MALL', name: '王府井百货', category: 'shopping' });
const restaurant = catalogPlace({ id: 'amap:FOOD', name: '烤鸭店', category: 'restaurant' });
const unnamed = catalogPlace({ id: 'amap:X', name: '示例地点甲' });

function core(place: Place, dayId = 'day-1', order = 1): TripPlace {
  return tripPlace({
    id: `tp:${place.id}:${dayId}`,
    dayId,
    placeId: place.id,
    placeName: place.name,
    type: place.category,
    order,
  });
}

function mealSlot(dayId: string): TripScheduleItem {
  return {
    kind: 'meal_slot',
    id: `${dayId}:meal:lunch`,
    mealPeriod: 'lunch',
    startTime: '12:00',
    durationMinutes: 75,
    areaTripPlaceId: `${dayId}:core-1`,
    diningMode: 'flexible',
  };
}

function mealPlace(tripPlaceId: string): TripScheduleItem {
  return {
    kind: 'meal_place',
    tripPlaceId,
    mealPeriod: 'lunch',
    startTime: '12:00',
    durationMinutes: 75,
  };
}

const lowWalkingPolicy = { targetCorePlacesPerDay: 2 as const };
const lowWalkingContext = {
  partyContext: {
    partyType: 'parents' as const,
    hasElderly: true,
    mobilityRequirement: 'low_walking' as const,
  },
  constraints: { excludedInterestKeys: [] as never[], lowWalking: true },
};

test('parents low-walking three-day trips meet core count and low-walking policy', () => {
  const days = [1, 2, 3].map((dayNumber) => day(
    [
      core(palace, `day-${dayNumber}`, 1),
      core(park, `day-${dayNumber}`, 2),
    ],
    [mealSlot(`day-${dayNumber}`)],
    dayNumber,
  ));
  const result = evaluateStyleFulfillmentAuditV1({
    trip: trip(days, {
      planningContext: {
        tripIntent: { interestKeys: ['history'] },
        ...lowWalkingContext,
      },
    }),
    places: [palace, park],
    policy: lowWalkingPolicy,
    ...lowWalkingContext,
    tripIntent: { interestKeys: ['history'] },
  });
  assert.equal(result.items.corePlaceCount.status, 'met');
  assert.equal(result.items.lowWalkingPolicy.status, 'met');
  assert.equal(result.overall, 'met');
});

test('old trips without planning context stay not_evaluable and do not throw', () => {
  assert.doesNotThrow(() => {
    const result = evaluateStyleFulfillmentAuditV1({
      trip: trip([day([core(palace)])]),
      places: [palace],
    });
    assert.equal(result.items.corePlaceCount.status, 'not_evaluable');
    assert.equal(result.items.lowWalkingPolicy.status, 'not_evaluable');
    assert.equal(result.items.excludedInterest.status, 'not_evaluable');
    assert.equal(result.items.intentCoverage.status, 'not_evaluable');
    assert.equal(result.overall === 'not_evaluable' || result.overall === 'partially_met', true);
  });
});

test('history intent with a heritage attraction core is covered', () => {
  const result = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(palace), core(park)], [mealSlot('day-1')])]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
    tripIntent: { interestKeys: ['history'] },
  });
  assert.equal(result.items.intentCoverage.status, 'met');
});

test('intent without recognizable poi features stays not_evaluable', () => {
  const result = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(unnamed)], undefined)]),
    places: [],
    tripIntent: { interestKeys: ['history'] },
  });
  assert.equal(result.items.intentCoverage.status, 'not_evaluable');
  assert.notEqual(result.items.intentCoverage.status, 'not_met');
});

test('excluded shopping rejects shopping cores but not restaurants or meal slots', () => {
  const withShopping = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(palace), core(mall)], [mealSlot('day-1')])]),
    places: [palace, mall],
    policy: { targetCorePlacesPerDay: 2 },
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  assert.equal(withShopping.items.excludedInterest.status, 'not_met');

  const withMeal = evaluateStyleFulfillmentAuditV1({
    trip: trip([day(
      [core(palace), core(park), tripPlace({
        id: 'tp:food',
        placeId: restaurant.id,
        placeName: restaurant.name,
        type: 'restaurant',
      })],
      [mealPlace('tp:food')],
    )]),
    places: [palace, park, restaurant],
    policy: { targetCorePlacesPerDay: 2 },
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  assert.equal(withMeal.items.excludedInterest.status, 'met');
  assert.equal(withMeal.items.mealArrangement.status, 'met');
});

test('meal arrangement covers meal_slot, meal_place and missing meals', () => {
  const slotOnly = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(palace), core(park)], [mealSlot('day-1')])]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(slotOnly.items.mealArrangement.status, 'met');

  const placeOnly = evaluateStyleFulfillmentAuditV1({
    trip: trip([day(
      [
        core(palace),
        core(park),
        tripPlace({
          id: 'tp:food',
          placeId: restaurant.id,
          placeName: restaurant.name,
          type: 'restaurant',
        }),
      ],
      [mealPlace('tp:food')],
    )]),
    places: [palace, park, restaurant],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(placeOnly.items.mealArrangement.status, 'met');

  const missing = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(palace), core(park)], [])]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(missing.items.mealArrangement.status, 'not_met');

  const noSchedule = evaluateStyleFulfillmentAuditV1({
    trip: trip([day([core(palace), core(park)])]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(noSchedule.items.mealArrangement.status, 'not_evaluable');
});

test('shadow evaluation swallows evaluator errors without changing the trip', () => {
  const built = trip([day([core(museum), core(park)], [mealSlot('day-1')])]);
  const before = structuredClone(built);
  assert.doesNotThrow(() => {
    shadowEvaluateGeneratedTripStyleFulfillmentV1({
      trip: built,
      places: [museum, park],
      policy: { targetCorePlacesPerDay: 2 },
      evaluate: () => {
        throw new Error('audit failed');
      },
    });
  });
  assert.deepEqual(built, before);
  assert.equal(JSON.stringify(built).includes('corePlaceCount'), false);
  assert.equal(JSON.stringify(built).includes('partially_met'), false);
});

test('style fulfillment audit types stay off trip API and display surfaces', () => {
  const roots = [
    readFileSync(join(process.cwd(), 'src/services/trip-display.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/services/bff-trip-generation-service.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'server/routes/trip-generate.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/services/trip-style-display.ts'), 'utf8'),
  ].join('\n');
  assert.equal(roots.includes('StyleFulfillmentAuditV1'), false);
  assert.equal(roots.includes('shadowEvaluateGeneratedTripStyleFulfillmentV1'), false);
  assert.equal(roots.includes('partially_met'), false);
});

test('identical audit inputs stay deterministic', () => {
  const input = {
    trip: trip([day([core(palace), core(park)], [mealSlot('day-1')])]),
    places: [palace, park],
    policy: { targetCorePlacesPerDay: 2 as const },
    tripIntent: { interestKeys: ['history' as const] },
    ...lowWalkingContext,
  };
  assert.deepEqual(
    evaluateStyleFulfillmentAuditV1(input),
    evaluateStyleFulfillmentAuditV1(structuredClone(input)),
  );
});
