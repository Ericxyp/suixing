import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLongStayTripPlace,
  planDaySchedule,
  resolveTripPace,
} from '../server/services/trip-day-density-planner';
import type { TripPlace } from '../src/domain/trip/types';

function stop(overrides: Partial<TripPlace> & Pick<TripPlace, 'id' | 'placeName'>): TripPlace {
  return {
    dayId: 'day-1',
    order: 1,
    placeId: overrides.id,
    type: 'attraction',
    estimatedCost: 0,
    startTime: '10:00',
    durationMinutes: 90,
    ...overrides,
  };
}

function twoOrdinaryPlaces(): TripPlace[] {
  return [
    stop({
      id: 'stop-1',
      placeName: '天坛公园',
      order: 1,
      startTime: '10:00',
      durationMinutes: 90,
      transportToNext: { mode: 'taxi', durationMinutes: 20, distanceMeters: 4000 },
    }),
    stop({
      id: 'stop-2',
      placeName: '颐和园',
      order: 2,
      startTime: '14:30',
      durationMinutes: 90,
    }),
  ];
}

function serialized(result: ReturnType<typeof planDaySchedule>): string {
  return JSON.stringify(result);
}

test('missing pace is treated as balanced', () => {
  assert.equal(resolveTripPace(undefined), 'balanced');
});

test('balanced two-place days add rest instead of generic experiences', () => {
  const snapshot = twoOrdinaryPlaces();
  const frozen = structuredClone(snapshot);
  Object.freeze(snapshot);
  const result = planDaySchedule({
    dayId: 'trip:day:1',
    destination: '北京',
    pace: 'balanced',
    places: snapshot,
    dayNumber: 1,
  });
  assert.deepEqual(snapshot, frozen);
  assert.equal(result.items.some((item) => item.kind === 'experience'), false);
  assert.equal(result.items.some((item) => item.kind === 'meal_slot'), true);
  assert.equal(result.items.some((item) => item.kind === 'hotel_return'), true);
  assert.equal(/自由活动|自由探索|附近逛逛|随便逛/.test(serialized(result)), false);
});

test('restaurant stops become meal schedule items', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    dayNumber: 1,
    places: [
      stop({ id: 'a', placeName: '北海公园', startTime: '10:00', durationMinutes: 90 }),
      stop({
        id: 'lunch',
        placeName: '仿膳饭庄',
        type: 'restaurant',
        order: 2,
        startTime: '12:00',
        durationMinutes: 60,
      }),
      stop({ id: 'b', placeName: '景山公园', order: 3, startTime: '14:00', durationMinutes: 90 }),
    ],
  });
  const lunch = result.items.find((item) => item.kind === 'meal_place');
  assert.equal(lunch?.kind === 'meal_place' && lunch.mealPeriod, 'lunch');
  assert.equal(result.items.some((item) => item.kind === 'rest'), false);
});

test('area walk requires a district place and two option pois', () => {
  const accepted = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    dayNumber: 1,
    places: [
      stop({ id: 'qianmen', placeName: '前门大街', startTime: '10:00', durationMinutes: 90 }),
      stop({ id: 'tiananmen', placeName: '天安门广场', order: 2, startTime: '12:00', durationMinutes: 90 }),
      stop({ id: 'zhengyang', placeName: '正阳门', order: 3, startTime: '14:00', durationMinutes: 60 }),
    ],
  });
  const walk = accepted.items.find((item) => item.kind === 'area_walk');
  assert.ok(walk);
  if (walk?.kind === 'area_walk') {
    assert.equal(walk.areaTripPlaceId, 'qianmen');
    assert.ok(walk.optionTripPlaceIds.length >= 2);
    assert.match(walk.title, /前门/);
    assert.equal(/自由探索|随便逛|不安排固定地点/.test(walk.description), false);
  }

  const rejected = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    places: twoOrdinaryPlaces(),
  });
  assert.equal(rejected.items.some((item) => item.kind === 'area_walk'), false);
});

test('packed three-place days skip hotel return', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'packed',
    dayNumber: 1,
    places: [
      stop({ id: 'a', placeName: '天安门广场', order: 1, startTime: '10:00', durationMinutes: 75 }),
      stop({ id: 'b', placeName: '国家博物馆', order: 2, startTime: '12:30', durationMinutes: 90 }),
      stop({ id: 'c', placeName: '王府井', order: 3, startTime: '15:30', durationMinutes: 90, type: 'shopping' }),
    ],
  });
  assert.equal(result.items.some((item) => item.kind === 'hotel_return'), false);
  assert.ok(result.reasons.includes('SKIPPED_PACKED'));
});

test('long museum stays still allow a rest slot', () => {
  const palace = stop({
    id: 'palace',
    placeName: '故宫博物院',
    startTime: '10:00',
    durationMinutes: 180,
  });
  assert.equal(isLongStayTripPlace(palace), true);
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    dayNumber: 1,
    places: [
      palace,
      stop({ id: 'jingshan', placeName: '景山公园', order: 2, startTime: '14:30', durationMinutes: 90 }),
    ],
  });
  const slot = result.items.find((item) => item.kind === 'meal_slot');
  assert.equal(slot?.kind === 'meal_slot' && slot.mealPeriod, 'lunch');
});

test('identical inputs produce identical plans', () => {
  const input = {
    dayId: 'trip:day:2',
    destination: '北京' as const,
    pace: 'balanced' as const,
    dayNumber: 2,
    places: twoOrdinaryPlaces(),
  };
  assert.deepEqual(planDaySchedule(input), planDaySchedule(structuredClone(input)));
});

test('schedule items do not overlap or pass 23:59', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    dayNumber: 1,
    places: [
      stop({ id: 'a', placeName: '北海公园', startTime: '10:00', durationMinutes: 90 }),
      stop({
        id: 'lunch',
        placeName: '仿膳饭庄',
        type: 'restaurant',
        order: 2,
        startTime: '12:00',
        durationMinutes: 60,
      }),
      stop({ id: 'b', placeName: '景山公园', order: 3, startTime: '14:00', durationMinutes: 90 }),
    ],
  });
  const ranges = result.items.map((item) => {
    const start = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3, 5));
    return { start, end: start + item.durationMinutes };
  });
  for (let index = 0; index < ranges.length; index += 1) {
    assert.ok(ranges[index].end <= 23 * 60 + 59);
    for (let other = index + 1; other < ranges.length; other += 1) {
      assert.equal(
        ranges[index].start < ranges[other].end && ranges[other].start < ranges[index].end,
        false,
      );
    }
  }
});

test('default dining mode inserts a flexible lunch slot instead of a restaurant', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    places: twoOrdinaryPlaces(),
  });
  const slot = result.items.find((item) => item.kind === 'meal_slot');
  assert.equal(slot?.kind === 'meal_slot' && slot.diningMode, 'flexible');
  assert.equal(slot?.kind === 'meal_slot' && slot.areaTripPlaceId, 'stop-1');
  assert.equal(result.items.some((item) => item.kind === 'meal_place'), false);
});

test('self-managed dining still creates a slot without arranged restaurants', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    diningMode: 'self_managed',
    places: twoOrdinaryPlaces(),
  });
  const slot = result.items.find((item) => item.kind === 'meal_slot');
  assert.ok(slot && slot.kind === 'meal_slot');
  if (slot?.kind === 'meal_slot') {
    assert.equal(slot.diningMode, 'self_managed');
  }
});

test('meal slots shift later places and never share a start with rest', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    places: twoOrdinaryPlaces(),
  });
  const starts = result.items.map((item) => item.startTime);
  assert.equal(new Set(starts).size, starts.length);
  const lunch = result.items.find((item) => item.kind === 'meal_slot');
  assert.ok(lunch);
  const rest = result.items.find((item) => item.kind === 'rest');
  assert.equal(rest, undefined);
  const second = result.places.find((place) => place.id === 'stop-2');
  const lunchStart = Number(lunch && lunch.startTime.slice(0, 2)) * 60 + Number(lunch && lunch.startTime.slice(3, 5));
  const lunchEnd = lunchStart + (lunch?.durationMinutes ?? 0);
  const secondStart = Number(second?.startTime?.slice(0, 2)) * 60 + Number(second?.startTime?.slice(3, 5));
  assert.ok((secondStart ?? 0) >= lunchEnd + 15 + 20);
  assert.equal(result.items.some((item) => item.kind === 'rest' && item.startTime === lunch?.startTime), false);
});

test('without a meal, a single short rest may cover noon', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    diningMode: 'arranged',
    places: [
      stop({ id: 'a', placeName: '北海公园', startTime: '10:00', durationMinutes: 90 }),
      stop({ id: 'b', placeName: '景山公园', order: 2, startTime: '14:00', durationMinutes: 90 }),
    ],
  });
  assert.equal(result.items.some((item) => item.kind === 'meal_slot'), false);
  assert.equal(result.items.some((item) => item.kind === 'rest'), false);
});

test('arranged dining without restaurants does not invent a lunch slot', () => {
  const result = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    diningMode: 'arranged',
    places: twoOrdinaryPlaces(),
  });
  assert.equal(result.items.some((item) => item.kind === 'meal_slot'), false);
  assert.equal(result.items.some((item) => item.kind === 'rest'), false);
});

