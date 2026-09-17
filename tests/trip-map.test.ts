import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Place,
  Trip,
  TripDay,
  TripPlace,
  TripRoute,
} from '../src/domain/trip/types';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import {
  getTripMapStopByTripPlaceId,
  isTripPlaceInDay,
  retainSelectedTripPlaceId,
  resolveTripMapRoutes,
  resolveTripMapStops,
  shouldFocusMapForSelection,
  shouldScrollTimelineForSelection,
  shouldClearSelectionAfterReplace,
  summarizeTripMapRoutes,
} from '../src/services/trip-map';

function tripPlace(
  id: string,
  order: number,
  placeId: string,
  placeName: string,
): TripPlace {
  return {
    id,
    dayId: 'day-1',
    order,
    placeId,
    placeName,
    type: 'attraction',
    estimatedCost: 0,
  };
}

function place(
  id: string,
  latitude: number,
  longitude: number,
): Place {
  return {
    id,
    provider: 'mock',
    providerPlaceId: `provider-${id}`,
    name: id,
    address: '上海',
    latitude,
    longitude,
    category: 'attraction',
  };
}

function dayWith(places: TripPlace[]): TripDay {
  return {
    id: 'day-1',
    tripId: 'trip-1',
    dayNumber: 1,
    date: '2026-10-01',
    places,
  };
}

function route(
  id: string,
  dayId: string,
  polyline: TripRoute['polyline'],
  distanceMeters = 1000,
  durationMinutes = 10,
): TripRoute {
  return {
    id,
    dayId,
    fromTripPlaceId: `${id}-from`,
    toTripPlaceId: `${id}-to`,
    transport: {
      mode: 'walk',
      distanceMeters,
      durationMinutes,
    },
    polyline,
  };
}

function tripWithRoutes(routes: TripRoute[]): Trip {
  return {
    id: 'trip-1',
    userId: 'user-1',
    title: '上海旅行',
    destination: '上海',
    travelerCount: 2,
    totalBudget: 3000,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: [] },
    status: 'PLANNING',
    days: [dayWith([])],
    routes,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

test('resolves map stops by placeId in TripPlace order', () => {
  const day = dayWith([
    tripPlace('trip-place-2', 2, 'place-2', '外滩'),
    tripPlace('trip-place-1', 1, 'place-1', '上海博物馆'),
  ]);
  const places = [
    place('place-2', 31.2401, 121.4908),
    place('place-1', 31.2303, 121.4748),
  ];

  assert.deepEqual(resolveTripMapStops(day, places), [
    {
      tripPlaceId: 'trip-place-1',
      order: 1,
      name: '上海博物馆',
      type: 'attraction',
      position: { latitude: 31.2303, longitude: 121.4748 },
    },
    {
      tripPlaceId: 'trip-place-2',
      order: 2,
      name: '外滩',
      type: 'attraction',
      position: { latitude: 31.2401, longitude: 121.4908 },
    },
  ]);
});

test('map stops ignore experience scheduleItems', () => {
  const day = dayWith([
    tripPlace('trip-place-1', 1, 'place-1', '上海博物馆'),
  ]);
  day.scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'trip-place-1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'experience',
      id: 'exp-1',
      startTime: '12:00',
      durationMinutes: 60,
      type: 'meal',
      title: '午间休息与用餐',
      description: '在附近安排用餐和休息，按现场节奏调整。',
    },
  ];
  const stops = resolveTripMapStops(day, [place('place-1', 31.2303, 121.4748)]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].tripPlaceId, 'trip-place-1');
});

test('map stops include meal places and ignore rest or area walk extras', () => {
  const restaurant = place('place-lunch', 31.231, 121.475);
  restaurant.category = 'restaurant';
  restaurant.name = '午餐店';
  const day = dayWith([
    tripPlace('trip-place-1', 1, 'place-1', '上海博物馆'),
    {
      ...tripPlace('trip-place-lunch', 2, 'place-lunch', '午餐店'),
      type: 'restaurant',
    },
  ]);
  day.scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'trip-place-1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal',
      tripPlaceId: 'trip-place-lunch',
      startTime: '12:00',
      durationMinutes: 60,
      mealPeriod: 'lunch',
    },
    {
      kind: 'rest',
      id: 'rest-1',
      startTime: '13:15',
      durationMinutes: 30,
      title: '午间休息',
      description: '稍作休息。',
    },
    {
      kind: 'area_walk',
      id: 'walk-1',
      startTime: '14:00',
      durationMinutes: 60,
      areaTripPlaceId: 'trip-place-1',
      optionTripPlaceIds: ['trip-place-1'],
      title: '街区慢逛',
      description: '以博物馆为主线。',
    },
  ];
  const stops = resolveTripMapStops(day, [
    place('place-1', 31.2303, 121.4748),
    restaurant,
  ]);
  assert.deepEqual(stops.map((stop) => stop.tripPlaceId), ['trip-place-1', 'trip-place-lunch']);
});

test('skips missing places and invalid coordinates', () => {
  const day = dayWith([
    tripPlace('valid', 1, 'valid-place', '有效地点'),
    tripPlace('missing', 2, 'missing-place', '缺失地点'),
    tripPlace('invalid-latitude', 3, 'invalid-latitude-place', '无效纬度'),
    tripPlace('invalid-longitude', 4, 'invalid-longitude-place', '无效经度'),
    tripPlace('nan', 5, 'nan-place', '非数字坐标'),
  ]);
  const places = [
    place('valid-place', 31.23, 121.47),
    place('invalid-latitude-place', 91, 121.47),
    place('invalid-longitude-place', 31.23, -181),
    place('nan-place', Number.NaN, 121.47),
  ];

  assert.deepEqual(resolveTripMapStops(day, places), [
    {
      tripPlaceId: 'valid',
      order: 1,
      name: '有效地点',
      type: 'attraction',
      position: { latitude: 31.23, longitude: 121.47 },
    },
  ]);
});

test('does not mutate TripDay, TripPlace, or Place inputs', () => {
  const day = dayWith([
    tripPlace('second', 2, 'place-2', '第二站'),
    tripPlace('first', 1, 'place-1', '第一站'),
  ]);
  const places = [
    place('place-1', 31.23, 121.47),
    place('place-2', 31.24, 121.49),
  ];
  const originalDay = structuredClone(day);
  const originalPlaces = structuredClone(places);

  resolveTripMapStops(day, places);

  assert.deepEqual(day, originalDay);
  assert.deepEqual(places, originalPlaces);
});

test('returns an empty list for an empty day', () => {
  assert.deepEqual(
    resolveTripMapStops(dayWith([]), [place('place-1', 31.23, 121.47)]),
    [],
  );
});

test('returns only internal display fields without AMap credentials or DTO data', () => {
  const stops = resolveTripMapStops(
    dayWith([tripPlace('trip-place-1', 1, 'place-1', '外滩')]),
    [place('place-1', 31.24, 121.49)],
  );
  const output = JSON.stringify(stops);

  assert.equal(output.includes('typecode'), false);
  assert.equal(output.includes('jscode'), false);
  assert.equal(output.includes('key'), false);
  assert.equal(output.includes('providerPlaceId'), false);
  assert.equal(output.includes('info'), false);
});

test('resolves only current-day routes in existing Trip route order', () => {
  const trip = tripWithRoutes([
    route('day-1-first', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.24, longitude: 121.48 },
    ]),
    route('day-2', 'day-2', [
      { latitude: 30.23, longitude: 120.47 },
      { latitude: 30.24, longitude: 120.48 },
    ]),
    route('day-1-second', 'day-1', [
      { latitude: 31.24, longitude: 121.48 },
      { latitude: 31.25, longitude: 121.49 },
    ]),
  ]);

  assert.deepEqual(
    resolveTripMapRoutes(trip, 'day-1').map((item) => item.routeId),
    ['day-1-first', 'day-1-second'],
  );
});

test('copies valid polyline points without reversing longitude and latitude', () => {
  const trip = tripWithRoutes([
    route('route-1', 'day-1', [
      { latitude: 31.2304, longitude: 121.4737 },
      { latitude: 31.2404, longitude: 121.4837 },
    ], 850, 12),
  ]);

  assert.deepEqual(resolveTripMapRoutes(trip, 'day-1'), [
    {
      routeId: 'route-1',
      fromTripPlaceId: 'route-1-from',
      toTripPlaceId: 'route-1-to',
      mode: 'walk',
      distanceMeters: 850,
      durationMinutes: 12,
      polyline: [
        { latitude: 31.2304, longitude: 121.4737 },
        { latitude: 31.2404, longitude: 121.4837 },
      ],
    },
  ]);
});

test('filters invalid and adjacent duplicate route points', () => {
  const trip = tripWithRoutes([
    route('route-1', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 91, longitude: 121.48 },
      { latitude: 31.24, longitude: 181 },
      { latitude: Number.NaN, longitude: 121.48 },
      { latitude: 31.25, longitude: 121.49 },
    ]),
  ]);

  assert.deepEqual(resolveTripMapRoutes(trip, 'day-1')[0].polyline, [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.25, longitude: 121.49 },
  ]);
});

test('skips routes with fewer than two valid distinct points', () => {
  const trip = tripWithRoutes([
    route('single', 'day-1', [{ latitude: 31.23, longitude: 121.47 }]),
    route('duplicates', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.23, longitude: 121.47 },
    ]),
    route('invalid', 'day-1', [
      { latitude: 91, longitude: 121.47 },
      { latitude: 31.23, longitude: 181 },
    ]),
  ]);

  assert.deepEqual(resolveTripMapRoutes(trip, 'day-1'), []);
});

test('does not mutate Trip routes or polyline arrays', () => {
  const trip = tripWithRoutes([
    route('route-1', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.24, longitude: 121.48 },
    ]),
  ]);
  const original = structuredClone(trip);

  resolveTripMapRoutes(trip, 'day-1');

  assert.deepEqual(trip, original);
});

test('returns no map routes when Trip has no routes', () => {
  assert.deepEqual(resolveTripMapRoutes(tripWithRoutes([]), 'day-1'), []);
});

test('summarizes distance and duration from valid resolved routes only', () => {
  const trip = tripWithRoutes([
    route('valid-1', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.24, longitude: 121.48 },
    ], 850, 12),
    route('invalid', 'day-1', [
      { latitude: 31.23, longitude: 121.47 },
    ], 9999, 999),
    route('valid-2', 'day-1', [
      { latitude: 31.24, longitude: 121.48 },
      { latitude: 31.25, longitude: 121.49 },
    ], 1200, 18),
  ]);
  const routes = resolveTripMapRoutes(trip, 'day-1');

  assert.deepEqual(summarizeTripMapRoutes(routes), {
    routeCount: 2,
    totalDistanceMeters: 2050,
    totalDurationMinutes: 30,
  });
  assert.equal(JSON.stringify(routes).includes('AMap'), false);
  assert.equal(JSON.stringify(routes).includes('jscode'), false);
});

function expectedPlaceForTripPlace(tripPlaceId: string): Place {
  const tripPlace = mockShanghaiTrip.days
    .flatMap((day) => day.places)
    .find((item) => item.id === tripPlaceId);
  assert.ok(tripPlace);
  const matchedPlace = mockPlaces.find((item) => item.id === tripPlace.placeId);
  assert.ok(matchedPlace);
  return matchedPlace;
}

function assertPointNearPlace(
  point: { latitude: number; longitude: number },
  matchedPlace: Place,
): void {
  const tolerance = 0.003;
  assert.ok(Math.abs(point.latitude - matchedPlace.latitude) <= tolerance);
  assert.ok(Math.abs(point.longitude - matchedPlace.longitude) <= tolerance);
}

test('Shanghai Mock Day 1 and Day 2 expose valid map routes', () => {
  const day1Routes = resolveTripMapRoutes(
    mockShanghaiTrip,
    mockShanghaiTrip.days[0].id,
  );
  const day2Routes = resolveTripMapRoutes(
    mockShanghaiTrip,
    mockShanghaiTrip.days[1].id,
  );

  assert.equal(day1Routes.length, 4);
  assert.equal(day2Routes.length, 4);
  for (const item of [...day1Routes, ...day2Routes]) {
    assert.ok(item.polyline.length >= 2);
    for (const point of item.polyline) {
      assert.ok(Number.isFinite(point.latitude));
      assert.ok(point.latitude >= -90 && point.latitude <= 90);
      assert.ok(Number.isFinite(point.longitude));
      assert.ok(point.longitude >= -180 && point.longitude <= 180);
    }
  }
});

test('Shanghai Mock route endpoints stay near their linked Places', () => {
  const routes = [
    ...resolveTripMapRoutes(mockShanghaiTrip, mockShanghaiTrip.days[0].id),
    ...resolveTripMapRoutes(mockShanghaiTrip, mockShanghaiTrip.days[1].id),
    ...resolveTripMapRoutes(mockShanghaiTrip, mockShanghaiTrip.days[2].id),
  ];

  assert.equal(routes.length, mockShanghaiTrip.routes.length);
  for (const item of routes) {
    const first = item.polyline[0];
    const last = item.polyline[item.polyline.length - 1];
    assertPointNearPlace(
      first,
      expectedPlaceForTripPlace(item.fromTripPlaceId),
    );
    assertPointNearPlace(
      last,
      expectedPlaceForTripPlace(item.toTripPlaceId),
    );
    assert.equal('latitude' in first, true);
    assert.equal('longitude' in first, true);
  }
});

test('resolving Shanghai Mock routes does not mutate source fixtures', () => {
  const originalTrip = structuredClone(mockShanghaiTrip);
  const originalPlaces = structuredClone(mockPlaces);

  for (const day of mockShanghaiTrip.days) {
    resolveTripMapRoutes(mockShanghaiTrip, day.id);
  }

  assert.deepEqual(mockShanghaiTrip, originalTrip);
  assert.deepEqual(mockPlaces, originalPlaces);
});

test('recognizes whether a selected TripPlace belongs to the current Day', () => {
  const day = dayWith([
    tripPlace('day-1-stop', 1, 'place-1', '第一站'),
  ]);

  assert.equal(isTripPlaceInDay(day, 'day-1-stop'), true);
  assert.equal(isTripPlaceInDay(day, 'another-day-stop'), false);
  assert.equal(isTripPlaceInDay(day, null), false);
});

test('keeps a current-Day selection and clears a selection from another Day', () => {
  const day = dayWith([
    tripPlace('day-1-stop', 1, 'place-1', '第一站'),
  ]);

  assert.equal(retainSelectedTripPlaceId(day, 'day-1-stop'), 'day-1-stop');
  assert.equal(retainSelectedTripPlaceId(day, 'day-2-stop'), null);
  assert.equal(retainSelectedTripPlaceId(day, null), null);
});

test('clears map selection when the replaced stop was selected', () => {
  assert.equal(shouldClearSelectionAfterReplace('day-2-stop:1', 'day-2-stop:1'), true);
  assert.equal(shouldClearSelectionAfterReplace('day-2-stop:2', 'day-2-stop:1'), false);
  assert.equal(shouldClearSelectionAfterReplace(null, 'day-2-stop:1'), false);
});

test('selection membership rules do not mutate Day or TripPlace data', () => {
  const day = dayWith([
    tripPlace('day-1-stop', 1, 'place-1', '第一站'),
  ]);
  const original = structuredClone(day);

  isTripPlaceInDay(day, 'day-1-stop');
  retainSelectedTripPlaceId(day, 'day-2-stop');

  assert.deepEqual(day, original);
});

test('finds a valid current-Day map stop by TripPlace ID', () => {
  const day = dayWith([
    tripPlace('day-1-stop', 1, 'place-1', '上海博物馆'),
  ]);
  const places = [place('place-1', 31.2303, 121.4748)];

  assert.deepEqual(
    getTripMapStopByTripPlaceId(day, places, 'day-1-stop'),
    {
      tripPlaceId: 'day-1-stop',
      order: 1,
      name: '上海博物馆',
      type: 'attraction',
      position: { latitude: 31.2303, longitude: 121.4748 },
    },
  );
  assert.equal(
    getTripMapStopByTripPlaceId(day, places, 'another-day-stop'),
    null,
  );
});

test('returns null when the selected stop has no valid Place coordinates', () => {
  const day = dayWith([
    tripPlace('missing', 1, 'missing-place', '缺失地点'),
    tripPlace('invalid', 2, 'invalid-place', '无效地点'),
  ]);

  assert.equal(
    getTripMapStopByTripPlaceId(day, [], 'missing'),
    null,
  );
  assert.equal(
    getTripMapStopByTripPlaceId(
      day,
      [place('invalid-place', 91, 121.47)],
      'invalid',
    ),
    null,
  );
});

test('map-stop lookup does not mutate Day or Place inputs', () => {
  const day = dayWith([
    tripPlace('day-1-stop', 1, 'place-1', '上海博物馆'),
  ]);
  const places = [place('place-1', 31.2303, 121.4748)];
  const originalDay = structuredClone(day);
  const originalPlaces = structuredClone(places);

  getTripMapStopByTripPlaceId(day, places, 'day-1-stop');

  assert.deepEqual(day, originalDay);
  assert.deepEqual(places, originalPlaces);
});

test('selection source rules prevent map and timeline feedback loops', () => {
  assert.equal(shouldScrollTimelineForSelection('map'), true);
  assert.equal(shouldFocusMapForSelection('map'), false);
  assert.equal(shouldScrollTimelineForSelection('timeline'), false);
  assert.equal(shouldFocusMapForSelection('timeline'), true);
  assert.equal(shouldScrollTimelineForSelection(null), false);
  assert.equal(shouldFocusMapForSelection(null), false);
});

test('map stops include visit time and category for place cards', () => {
  const day = dayWith([
    {
      ...tripPlace('timed', 1, 'place-1', '故宫博物院'),
      startTime: '10:00',
    },
    tripPlace('untimed', 2, 'place-2', '景山公园'),
  ]);
  const stops = resolveTripMapStops(day, [
    place('place-1', 39.916, 116.397),
    place('place-2', 39.923, 116.395),
  ]);
  assert.equal(stops[0].startTime, '10:00');
  assert.equal(stops[0].type, 'attraction');
  assert.equal(stops[1].startTime, undefined);
});

test('shanghai mock catalog places still locate every day on the map', () => {
  for (const day of mockShanghaiTrip.days) {
    const stops = resolveTripMapStops(day, mockPlaces);
    assert.ok(stops.length > 0);
    assert.equal(stops.every((stop) => Number.isFinite(stop.position.latitude)), true);
  }
});

test('TripMap does not create polylines and uses place-card markers', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/trip/TripMap.tsx'), 'utf8');
  assert.equal(source.includes('new AMapApi.Polyline'), false);
  assert.equal(source.includes('Polyline'), false);
  assert.match(source, /trip-map-place-card/);
  assert.match(source, /textContent = stop\.name/);
  assert.match(source, /时间待定/);
  const page = readFileSync(join(process.cwd(), 'src/pages/TripDetailPage.tsx'), 'utf8');
  assert.equal(page.includes('mockPlaces'), false);
  assert.match(page, /getPlacesForTrip/);
});
