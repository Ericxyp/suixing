import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDistance,
  formatDuration,
  formatTripDates,
  getDefaultTripDayId,
  itineraryTimelineItems,
  statusLabel,
  tripPreferenceTags,
  dayWorkspaceSummary,
  formatDayWorkspaceSummary,
  mealPeriodTitle,
  restItemTitle,
  visibleUserText,
  isInternalDisplayLeak,
  formatCompactDuration,
} from '../src/services/trip-display';
import { mockShanghaiTrip } from '../src/mocks/trips';

test('formats Trip display values', () => {
  assert.equal(formatDuration(12), '12分钟');
  assert.equal(formatDuration(60), '1小时');
  assert.equal(formatDuration(90), '1小时30分钟');
  assert.equal(formatDuration(120), '2小时');
  assert.equal(formatDistance(850), '850m');
  assert.equal(formatDistance(1000), '1km');
  assert.equal(formatDistance(3600), '3.6km');
  assert.equal(formatTripDates(mockShanghaiTrip), '10月1日—10月3日');
  assert.equal(formatTripDates({ ...mockShanghaiTrip, startDate: undefined }), '日期待定');
  assert.deepEqual(statusLabel, { PLANNING: '规划中', READY: '已就绪', TRAVELLING: '旅行中', COMPLETED: '已完成' });
});

test('chooses a safe default Day without mutating the Trip', () => {
  const trip = structuredClone(mockShanghaiTrip);
  assert.equal(getDefaultTripDayId({ ...trip, days: [] }), undefined);
  assert.equal(getDefaultTripDayId(trip), 'trip-day-shanghai-1');
  assert.equal(getDefaultTripDayId({ ...trip, status: 'TRAVELLING' }, new Date(2026, 9, 2)), 'trip-day-shanghai-2');
  assert.equal(getDefaultTripDayId({ ...trip, status: 'TRAVELLING' }, new Date(2026, 8, 1)), 'trip-day-shanghai-1');
  assert.deepEqual(trip, mockShanghaiTrip);
});

test('timeline falls back to TripPlace rows when scheduleItems are missing', () => {
  const items = itineraryTimelineItems(mockShanghaiTrip.days[0]);
  assert.equal(items.every((item) => item.kind === 'place'), true);
  assert.equal(items[0]?.kind === 'place' && items[0].tripPlaceId, mockShanghaiTrip.days[0].places[0].id);
});

test('timeline uses stored scheduleItems including experiences', () => {
  const day = structuredClone(mockShanghaiTrip.days[0]);
  day.scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: day.places[0].id,
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'experience',
      id: `${day.id}:exp:1`,
      startTime: '12:00',
      durationMinutes: 60,
      type: 'meal',
      title: '午间休息与用餐',
      description: '在附近安排用餐和休息，按现场节奏调整。',
    },
  ];
  const items = itineraryTimelineItems(day);
  assert.equal(items.length, 2);
  assert.equal(items[1]?.kind, 'experience');
});

test('timeline keeps meal and area walk items', () => {
  const day = structuredClone(mockShanghaiTrip.days[0]);
  day.places.push({
    ...day.places[0],
    id: `${day.places[0].id}-lunch`,
    placeId: 'place-lunch',
    placeName: '午餐店',
    type: 'restaurant',
    order: day.places.length + 1,
  });
  day.scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: day.places[0].id,
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal',
      tripPlaceId: `${day.places[0].id}-lunch`,
      startTime: '12:00',
      durationMinutes: 60,
      mealPeriod: 'lunch',
    },
  ];
  const items = itineraryTimelineItems(day);
  assert.equal(items[1]?.kind, 'meal');
});

test('timeline preserves unique meal slot and place start times', () => {
  const day = structuredClone(mockShanghaiTrip.days[0]);
  day.scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: day.places[0].id,
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'lunch',
      mealPeriod: 'lunch',
      startTime: '11:45',
      durationMinutes: 75,
      areaTripPlaceId: day.places[0].id,
      nextTripPlaceId: day.places[1].id,
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: day.places[1].id,
      startTime: '13:35',
      durationMinutes: 90,
    },
  ];
  const items = itineraryTimelineItems(day);
  assert.deepEqual(items.map((item) => item.startTime), ['10:00', '11:45', '13:35']);
  assert.equal(items.some((item) => item.kind === 'rest'), false);
});

test('preference tags only include real interests', () => {
  assert.equal(tripPreferenceTags(mockShanghaiTrip).length, 3);
  assert.deepEqual(tripPreferenceTags(mockShanghaiTrip), ['咖啡', '拍照', '城市漫步']);
  const bare = structuredClone(mockShanghaiTrip);
  bare.preferences = { interests: [] };
  assert.deepEqual(tripPreferenceTags(bare), []);
  bare.preferences = { interests: ['', '  ', '博物馆'] };
  assert.deepEqual(tripPreferenceTags(bare), ['博物馆']);
});

test('day summary counts trip places and real transit only', () => {
  const day = mockShanghaiTrip.days[0];
  const withRoutes = dayWorkspaceSummary(mockShanghaiTrip, day);
  assert.equal(withRoutes.placeCount, day.places.length);
  assert.equal(typeof withRoutes.transitMinutes, 'number');
  const noRoutes = dayWorkspaceSummary({ ...mockShanghaiTrip, routes: [] }, day);
  assert.equal(noRoutes.transitMinutes, undefined);
  assert.equal(formatDayWorkspaceSummary({ placeCount: 3 }), '3 个地点');
  assert.equal(formatDayWorkspaceSummary({ placeCount: 3, transitMinutes: 56 }), '3 个地点 · 交通约 56分钟');
});

test('schedule labels stay user-facing and hide internal leaks', () => {
  assert.equal(mealPeriodTitle('lunch', 'meal_slot'), '午餐时间');
  assert.equal(mealPeriodTitle('dinner', 'meal_place'), '晚餐');
  assert.equal(restItemTitle('参观后休息'), '参观后休息');
  assert.equal(restItemTitle('${s.type}'), '午间休息');
  assert.equal(visibleUserText('undefined'), undefined);
  assert.equal(visibleUserText('meal_slot'), undefined);
  assert.equal(isInternalDisplayLeak('$(s.type)'), true);
  assert.equal(formatCompactDuration(150), '2.5h');
  assert.equal(formatCompactDuration(75), '1h15min');
});
