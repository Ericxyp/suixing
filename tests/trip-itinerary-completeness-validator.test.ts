import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDayItineraryCompleteness } from '../server/services/trip-itinerary-completeness-validator';
import type { TripScheduleItem } from '../src/domain/trip/types';

function place(id: string, start: string, duration = 90): TripScheduleItem {
  return { kind: 'place', tripPlaceId: id, startTime: start, durationMinutes: duration };
}

test('balanced days require lunch coverage, evening purpose and no placeholders', () => {
  const valid = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b', 'c', 'lunch', 'dinner']),
    corePlaceCount: 3,
    items: [
      place('a', '10:00'),
      { kind: 'meal', tripPlaceId: 'lunch', startTime: '12:00', durationMinutes: 60, mealPeriod: 'lunch' },
      place('b', '13:30'),
      place('c', '15:30'),
      { kind: 'meal', tripPlaceId: 'dinner', startTime: '17:30', durationMinutes: 75, mealPeriod: 'dinner' },
    ],
  });
  assert.equal(valid.valid, true);

  const generic = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      {
        kind: 'experience',
        id: 'x',
        startTime: '12:00',
        durationMinutes: 60,
        type: 'free_time',
        title: '自由活动',
        description: '附近逛逛',
      },
      place('b', '14:00'),
    ],
  });
  assert.equal(generic.valid, false);
  assert.equal(generic.reason, 'GENERIC_PLACEHOLDER');
});

test('rejects invalid area walks and missing cores', () => {
  const missingOptions = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['area', 'a']),
    corePlaceCount: 2,
    items: [
      place('area', '10:00'),
      { kind: 'rest', id: 'r', startTime: '12:00', durationMinutes: 30, title: '午间休息', description: '稍作休息。' },
      {
        kind: 'area_walk',
        id: 'w',
        startTime: '14:00',
        durationMinutes: 60,
        areaTripPlaceId: 'area',
        optionTripPlaceIds: ['a'],
        title: '街区慢逛',
        description: '以区域为主线。',
      },
    ],
  });
  assert.equal(missingOptions.valid, false);
  assert.equal(missingOptions.reason, 'INVALID_AREA_WALK');

  const cores = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a']),
    corePlaceCount: 1,
    items: [place('a', '10:00')],
  });
  assert.equal(cores.valid, false);
  assert.equal(cores.reason, 'MISSING_CORE_PLACES');
});

test('unexplained gaps and early endings fail', () => {
  const gap = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      { kind: 'rest', id: 'r', startTime: '12:00', durationMinutes: 30, title: '午间休息', description: '稍作休息。' },
      place('b', '16:00'),
    ],
  });
  assert.equal(gap.valid, false);
  assert.equal(gap.reason, 'UNEXPLAINED_GAP');

  const early = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      { kind: 'rest', id: 'r', startTime: '12:00', durationMinutes: 45, title: '午间休息', description: '稍作休息。' },
      place('b', '13:00'),
    ],
  });
  assert.equal(early.valid, false);
  assert.equal(early.reason, 'DAY_ENDS_TOO_EARLY');
});

test('accepts a legal meal slot and still rejects generic free activity', () => {
  const withSlot = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '11:45',
        durationMinutes: 75,
        areaTripPlaceId: 'a',
        nextTripPlaceId: 'b',
        diningMode: 'flexible',
      },
      place('b', '13:30', 180),
      {
        kind: 'hotel_return',
        id: 'back',
        startTime: '17:00',
        durationMinutes: 30,
        title: '返程准备',
        description: '结束当天行程，返回住处。',
      },
    ],
  });
  assert.equal(withSlot.valid, true);

  const generic = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      {
        kind: 'experience',
        id: 'x',
        startTime: '12:00',
        durationMinutes: 60,
        type: 'free_time',
        title: '自由活动',
        description: '附近逛逛',
      },
      place('b', '14:00'),
    ],
  });
  assert.equal(generic.valid, false);
});

test('legal two-core downgrade requires a long stay, six hours and a 17:00 finish', () => {
  const legal = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00', 180),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '13:15',
        durationMinutes: 75,
        areaTripPlaceId: 'a',
        nextTripPlaceId: 'b',
        diningMode: 'flexible',
      },
      place('b', '14:45', 90),
      {
        kind: 'hotel_return',
        id: 'back',
        startTime: '16:45',
        durationMinutes: 45,
        title: '返程准备',
        description: '结束当天行程，返回住处。',
      },
    ],
  });
  assert.equal(legal.valid, true);

  const overlap = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00', 180),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '11:30',
        durationMinutes: 75,
        areaTripPlaceId: 'a',
        diningMode: 'flexible',
      },
      {
        kind: 'rest',
        id: 'r',
        startTime: '11:30',
        durationMinutes: 45,
        title: '午间休息',
        description: '稍作休息。',
      },
      place('b', '13:30', 90),
    ],
  });
  assert.equal(overlap.valid, false);
  assert.ok(overlap.reason === 'MEAL_REST_CONFLICT' || overlap.reason === 'SCHEDULE_OVERLAP' || overlap.reason === 'INVALID_TWO_PLACE_DAY');
});

test('relaxed two cores are allowed without generic free time', () => {
  const valid = validateDayItineraryCompleteness({
    pace: 'relaxed',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '11:45',
        durationMinutes: 75,
        areaTripPlaceId: 'a',
        nextTripPlaceId: 'b',
        diningMode: 'flexible',
      },
      place('b', '13:30'),
      {
        kind: 'hotel_return',
        id: 'back',
        startTime: '16:00',
        durationMinutes: 45,
        title: '返程准备',
        description: '结束当天行程，返回住处。',
      },
    ],
  });
  assert.equal(valid.valid, true);
});

test('packed days require three cores and do not invent a fourth', () => {
  const valid = validateDayItineraryCompleteness({
    pace: 'packed',
    placeIds: new Set(['a', 'b', 'c']),
    corePlaceCount: 3,
    items: [
      place('a', '10:00', 75),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '11:30',
        durationMinutes: 60,
        areaTripPlaceId: 'a',
        nextTripPlaceId: 'b',
        diningMode: 'flexible',
      },
      place('b', '12:45', 90),
      place('c', '15:00', 90),
    ],
  });
  assert.equal(valid.valid, true);
  const short = validateDayItineraryCompleteness({
    pace: 'packed',
    placeIds: new Set(['a', 'b']),
    corePlaceCount: 2,
    items: [
      place('a', '10:00'),
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '11:45',
        durationMinutes: 75,
        areaTripPlaceId: 'a',
        diningMode: 'flexible',
      },
      place('b', '13:30'),
      {
        kind: 'hotel_return',
        id: 'back',
        startTime: '16:30',
        durationMinutes: 45,
        title: '返程准备',
        description: '结束当天行程，返回住处。',
      },
    ],
  });
  assert.equal(short.valid, false);
  assert.equal(short.reason, 'INSUFFICIENT_CORE_PLACES');
});

