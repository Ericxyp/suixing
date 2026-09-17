import type { TripDay, TripRoute } from '../domain/trip/types';
import type { TripChange } from '../domain/trip/trip-change';
import { mockShanghaiTrip } from './trips';

const dayTwoBefore = structuredClone(mockShanghaiTrip.days[1]);
const replacementMuseum = {
  id: 'preview-tp-d2-museum',
  placeId: 'place-shanghai-museum',
  placeName: '上海博物馆',
  type: 'attraction' as const,
  order: 2,
  startTime: '10:15',
  durationMinutes: 120,
  description: '参观中国古代艺术馆藏，建议提前预约。',
  estimatedCost: 0,
  transportToNext: {
    mode: 'walk' as const,
    durationMinutes: 5,
    distanceMeters: 350,
    description: '步行至人民广场',
  },
};

const dayTwoAfter: TripDay = {
  ...structuredClone(dayTwoBefore),
  places: [
    dayTwoBefore.places[0],
    {
      ...replacementMuseum,
      id: 'preview-tp-d2-museum',
      dayId: dayTwoBefore.id,
      order: 2,
    },
    ...dayTwoBefore.places.slice(2),
  ],
};

const dayTwoBeforeRoutes = structuredClone(
  mockShanghaiTrip.routes.filter((route) => route.dayId === dayTwoBefore.id),
);

const dayTwoAfterRoutes: TripRoute[] = [
  {
    id: 'preview-route-d2-1',
    dayId: dayTwoBefore.id,
    fromTripPlaceId: 'tp-d2-hotel',
    toTripPlaceId: 'preview-tp-d2-museum',
    transport: {
      mode: 'taxi',
      durationMinutes: 31,
      distanceMeters: 5900,
      description: '前往上海博物馆',
    },
  },
  {
    id: 'preview-route-d2-2',
    dayId: dayTwoBefore.id,
    fromTripPlaceId: 'preview-tp-d2-museum',
    toTripPlaceId: 'tp-d2-square',
    transport: {
      mode: 'walk',
      durationMinutes: 5,
      distanceMeters: 350,
      description: '步行至人民广场',
    },
  },
  ...dayTwoBeforeRoutes
    .filter((route) => !['route-d2-1', 'route-d2-2'].includes(route.id))
    .map((route) => structuredClone(route)),
];

export const mockShanghaiTripChangePreview: TripChange = {
  id: 'trip-change-shanghai-day-2-museum',
  tripId: mockShanghaiTrip.id,
  status: 'PENDING_CONFIRMATION',
  operations: [
    {
      type: 'REMOVE',
      dayId: dayTwoBefore.id,
      targetTripPlaceId: 'tp-d2-wukang',
    },
    {
      type: 'ADD',
      dayId: dayTwoBefore.id,
      replacementPlaceId: 'place-shanghai-museum',
      payload: replacementMuseum,
    },
  ],
  beforeSnapshot: {
    totalBudget: 3820,
    pace: 'relaxed',
    days: [dayTwoBefore],
    routes: dayTwoBeforeRoutes,
  },
  afterPreview: {
    totalBudget: 3790,
    pace: 'relaxed',
    days: [dayTwoAfter],
    routes: dayTwoAfterRoutes,
  },
  costDelta: -30,
  timeDeltaMinutes: -12,
  reason: '上海博物馆与下午路线更顺，可减少约 12 分钟交通时间，同时保持原有轻松节奏。',
  createdAt: '2026-09-13T00:00:00.000Z',
};
