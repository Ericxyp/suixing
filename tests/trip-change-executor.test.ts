import assert from 'node:assert/strict';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import type { PlaceSearchInput } from '../server/services/amap-place-service';
import type {
  RoutePlanningInput,
  RouteResult,
} from '../server/services/amap-route-service';
import {
  AmapTripChangeExecutor,
  TRIP_CHANGE_INCOMPLETE_MESSAGE,
  TRIP_CHANGE_INVALID_REQUEST_MESSAGE,
  TRIP_CHANGE_PROVIDER_ERROR_MESSAGE,
  TRIP_CHANGE_PROVIDER_UNAVAILABLE_MESSAGE,
  TRIP_CHANGE_SEARCH_LIMIT,
  TripChangeExecutionError,
} from '../server/services/trip-change-executor';
import { validateDayItineraryCompleteness } from '../server/services/trip-itinerary-completeness-validator';
import { parseClockMinutes } from '../server/services/trip-day-density-planner';
import type { PlaceSearchService } from '../server/services/trip-place-resolver';
import {
  AmapTripRouteEnricher,
  type RoutePlanningService,
} from '../server/services/trip-route-enricher';
import type { GeoPoint, Place, Trip, TripPlace, TripRoute } from '../src/domain/trip/types';
import type { TripPlanningContextV1 } from '../src/domain/trip/profile';

function geo(latitude: number, longitude: number): GeoPoint {
  return { latitude, longitude };
}

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
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

const palace = place({ id: 'amap:PALACE', name: '故宫' });
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.397 });
const wall = place({ id: 'amap:WALL', name: '八达岭长城', latitude: 40.359, longitude: 116.02 });
const stadium = place({ id: 'amap:STADIUM', name: '国家体育场', latitude: 39.993, longitude: 116.397 });
const summer = place({ id: 'amap:SUMMER', name: '颐和园', latitude: 39.999, longitude: 116.275 });
const unused = place({ id: 'amap:UNUSED', name: '圆明园', latitude: 40.008, longitude: 116.298 });
const lunchSpot = place({
  id: 'amap:LUNCH',
  name: '故宫附近餐厅',
  category: 'restaurant',
  latitude: 39.917,
  longitude: 116.398,
});
const dinnerSpot = place({
  id: 'amap:DINNER',
  name: '晚间餐厅',
  category: 'restaurant',
  latitude: 39.926,
  longitude: 116.397,
});

function tripPlace(
  dayId: string,
  order: number,
  mapped: Place,
  extras: Partial<TripPlace> = {},
): TripPlace {
  return {
    id: `${dayId}:stop:${order}`,
    dayId,
    order,
    placeId: mapped.id,
    placeName: mapped.name,
    type: mapped.category,
    startTime: extras.startTime ?? (order === 1 ? '10:00' : '12:00'),
    durationMinutes: extras.durationMinutes ?? 90,
    description: extras.description ?? `${mapped.name}停留。`,
    estimatedCost: extras.estimatedCost ?? 0,
    ...extras,
  };
}

function routeBetween(dayId: string, from: TripPlace, to: TripPlace, dayNumber: number): TripRoute {
  return {
    id: `trip-bj:day:${dayNumber}:route:1`,
    dayId,
    fromTripPlaceId: from.id,
    toTripPlaceId: to.id,
    transport: {
      mode: 'taxi',
      durationMinutes: 18,
      distanceMeters: 4200,
      description: '打车前往下站',
    },
    polyline: [
      geo(39.9, 116.4),
      geo(39.92, 116.4),
    ],
  };
}

function sampleTrip(): Trip {
  const day1Places = [
    tripPlace('day-1', 1, palace, { startTime: '10:00' }),
    tripPlace('day-1', 2, park, { startTime: '12:00' }),
  ];
  const day2Places = [
    tripPlace('day-2', 1, wall, { startTime: '19:30' }),
    tripPlace('day-2', 2, stadium, { startTime: '21:00' }),
  ];
  day1Places[0].transportToNext = {
    mode: 'taxi',
    durationMinutes: 18,
    distanceMeters: 4200,
  };
  day2Places[0].transportToNext = {
    mode: 'taxi',
    durationMinutes: 18,
    distanceMeters: 4200,
  };
  return {
    id: 'trip-bj',
    userId: 'user-1',
    title: '北京 2 日游',
    destination: '北京',
    travelerCount: 2,
    totalBudget: 3000,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: ['博物馆'] },
    status: 'PLANNING',
    days: [
      {
        id: 'day-1',
        tripId: 'trip-bj',
        dayNumber: 1,
        date: '2026-09-20',
        title: '城区漫步',
        summary: '故宫与景山。',
        places: day1Places,
      },
      {
        id: 'day-2',
        tripId: 'trip-bj',
        dayNumber: 2,
        date: '2026-09-21',
        title: '北郊一日',
        summary: '长城与鸟巢。',
        places: day2Places,
      },
    ],
    routes: [
      routeBetween('day-1', day1Places[0], day1Places[1], 1),
      routeBetween('day-2', day2Places[0], day2Places[1], 2),
    ],
    createdAt: '2026-09-16T01:00:00.000Z',
    updatedAt: '2026-09-16T02:00:00.000Z',
  };
}

function catalog(extra: Place[] = []): Place[] {
  return [palace, park, wall, stadium, unused, ...extra].map((item) => structuredClone(item));
}

function replaceWallOp() {
  return {
    type: 'REPLACE_PLACE' as const,
    dayNumber: 2,
    targetTripPlaceId: 'day-2:stop:1',
    replacementQuery: '颐和园',
  };
}

class FakePlaceSearch implements PlaceSearchService {
  calls: PlaceSearchInput[] = [];
  detailCalls: string[] = [];

  constructor(
    private readonly handler: (input: PlaceSearchInput) => Promise<Place[]>,
    private readonly detailHandler?: (providerPlaceId: string) => Promise<Place | null>,
  ) {}

  async search(input: PlaceSearchInput): Promise<Place[]> {
    this.calls.push({
      query: input.query,
      city: input.city,
      limit: input.limit,
    });
    const found = await this.handler(input);
    if (/餐厅|晚餐/.test(input.query)) {
      const food = found.filter((item) => item.category === 'restaurant' || item.category === 'cafe');
      if (food.length > 0) {
        return food;
      }
      return [structuredClone(input.query.includes('晚餐') ? dinnerSpot : lunchSpot)];
    }
    if (/附近 景点|博物馆|公园|历史街区|城区/.test(input.query)) {
      const anchor = found[0] ?? unused;
      const extra = {
        ...structuredClone(unused),
        latitude: anchor.latitude,
        longitude: anchor.longitude,
      };
      if (found.some((item) => item.id === unused.id)) {
        return found;
      }
      return [...found, extra];
    }
    return found;
  }

  async getByProviderPlaceId(providerPlaceId: string): Promise<Place | null> {
    this.detailCalls.push(providerPlaceId);
    if (this.detailHandler) {
      return this.detailHandler(providerPlaceId);
    }
    return null;
  }
}

class FakeRouteService implements RoutePlanningService {
  calls: RoutePlanningInput[] = [];

  constructor(
    private readonly handler: (input: RoutePlanningInput) => Promise<RouteResult> = async (input) => ({
      transport: {
        mode: input.mode,
        distanceMeters: input.mode === 'walk' ? 900 : 3200,
        durationMinutes: input.mode === 'walk' ? 12 : 18,
      },
      polyline: [
        { latitude: input.origin.latitude, longitude: input.origin.longitude },
        { latitude: input.destination.latitude, longitude: input.destination.longitude },
      ],
    }),
  ) {}

  async plan(input: RoutePlanningInput): Promise<RouteResult> {
    this.calls.push({
      origin: structuredClone(input.origin),
      destination: structuredClone(input.destination),
      mode: input.mode,
    });
    return this.handler(input);
  }
}

function executor(search: FakePlaceSearch, routes = new FakeRouteService()) {
  return {
    search,
    routes,
    service: new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(routes)),
  };
}

async function expectInvalid(
  run: () => Promise<unknown>,
  search: FakePlaceSearch,
  routes: FakeRouteService,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TripChangeExecutionError);
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.message, TRIP_CHANGE_INVALID_REQUEST_MESSAGE);
    return true;
  });
  assert.equal(search.calls.length, 0);
  assert.equal(routes.calls.length, 0);
}

test('replaces a legal stop and leaves the original trip, places and operation unchanged', async () => {
  const trip = sampleTrip();
  const places = catalog();
  const operation = replaceWallOp();
  const tripSnapshot = structuredClone(trip);
  const placesSnapshot = structuredClone(places);
  const operationSnapshot = structuredClone(operation);
  const { search, routes, service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));

  const result = await service.replacePlace({
    trip,
    places,
    operation,
    updatedAt: '2026-09-16T12:00:00.000Z',
  });

  assert.notEqual(result.trip, trip);
  assert.deepEqual(trip, tripSnapshot);
  assert.deepEqual(places, placesSnapshot);
  assert.deepEqual(operation, operationSnapshot);
  assert.equal(result.trip.id, 'trip-bj');
  assert.equal(result.trip.userId, 'user-1');
  assert.equal(result.trip.title, '北京 2 日游');
  assert.equal(result.trip.createdAt, trip.createdAt);
  assert.equal(result.trip.updatedAt, '2026-09-16T12:00:00.000Z');
  assert.equal(result.trip.days[1].places[0].placeId, 'amap:SUMMER');
  assert.equal(result.trip.days[1].places[0].placeName, '颐和园');
  assert.deepEqual(result.summary, {
    type: 'REPLACE_PLACE',
    dayNumber: 2,
    replacedTripPlaceId: 'day-2:stop:1',
    previousPlaceName: '八达岭长城',
    nextPlaceName: '颐和园',
    routeRecalculated: true,
  });
  assert.equal(search.calls[0]?.query, '颐和园');
  assert.ok(search.calls.length >= 1);
  assert.ok(routes.calls.length >= 1);
});

test('only the target day and target trip place change; other days stay logically equal', async () => {
  const trip = sampleTrip();
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });

  assert.deepEqual(result.trip.days[0], trip.days[0]);
  assert.deepEqual(
    result.trip.routes.filter((item) => item.dayId === 'day-1'),
    trip.routes.filter((item) => item.dayId === 'day-1'),
  );
  assert.equal(result.trip.days[1].places.some((place) => place.placeId === stadium.id), true);
  assert.equal(result.trip.days[1].places.find((place) => place.placeId === stadium.id)?.placeName, stadium.name);
});

test('keeps target trip place identity and updates place id, name and type', async () => {
  const trip = sampleTrip();
  const garden = place({
    id: 'amap:XIE',
    name: '谐趣园',
    category: 'attraction',
    latitude: 39.998,
    longitude: 116.274,
  });
  const { service } = executor(new FakePlaceSearch(async () => [garden]));
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  const target = result.trip.days[1].places[0];
  assert.equal(target.id, 'day-2:stop:1');
  assert.equal(target.dayId, 'day-2');
  assert.equal(target.order, 1);
  assert.equal(target.placeId, 'amap:XIE');
  assert.equal(target.placeName, '谐趣园');
  assert.equal(target.type, 'attraction');
  assert.equal(target.durationMinutes, 90);
  assert.equal(target.description, '八达岭长城停留。');
  assert.equal(target.estimatedCost, 0);
});

test('new place comes from the fake place service, not a handmade fallback', async () => {
  const stamped = place({
    id: 'amap:LIVE',
    name: '颐和园',
    providerPlaceId: 'live-poi-1',
    address: '服务返回的地址',
    latitude: 39.9991,
    longitude: 116.2751,
  });
  const { search, service } = executor(new FakePlaceSearch(async () => [structuredClone(stamped)]));
  const result = await service.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  const output = result.places.find((item) => item.id === 'amap:LIVE');
  assert.ok(output);
  assert.equal(output.providerPlaceId, 'live-poi-1');
  assert.equal(output.address, '服务返回的地址');
  assert.equal(output.latitude, 39.9991);
  assert.ok(search.calls.length >= 1);
});

test('selects candidates by exact name, contains match, category, then stable Place.id', async () => {
  const contains = place({ id: 'amap:C1', name: '颐和园东门', latitude: 39.999, longitude: 116.275 });
  const exact = place({ id: 'amap:C2', name: '颐和园', latitude: 39.999, longitude: 116.275 });
  const { service: exactService } = executor(
    new FakePlaceSearch(async () => [contains, exact]),
  );
  const exactResult = await exactService.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(exactResult.trip.days[1].places[0].placeId, 'amap:C2');

  const fuzzy = place({ id: 'amap:C3', name: '昆明湖游船' });
  const { service: containsService } = executor(
    new FakePlaceSearch(async () => [fuzzy, contains]),
  );
  await assert.rejects(
    () => containsService.replacePlace({
      trip: sampleTrip(),
      places: catalog(),
      operation: replaceWallOp(),
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.message, TRIP_CHANGE_INCOMPLETE_MESSAGE);
      return true;
    },
  );

  const first = place({ id: 'amap:O1', name: '北宫门广场', latitude: 40.0, longitude: 116.27 });
  const second = place({ id: 'amap:O2', name: '西堤步道', latitude: 39.99, longitude: 116.26 });
  const { service: orderService } = executor(
    new FakePlaceSearch(async () => [second, first]),
  );
  const orderResult = await orderService.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(orderResult.trip.days[1].places[0].placeId, 'amap:O1');
});

test('replacePlace prefers a main landmark over accessory POIs from the same query', async () => {
  const pavilion = place({ id: 'amap:TING', name: '瘦西湖凉亭', latitude: 32.42, longitude: 119.42 });
  const scenic = place({ id: 'amap:SCENIC', name: '瘦西湖风景区', latitude: 32.41, longitude: 119.41 });
  const returned = [pavilion, scenic];
  Object.freeze(returned);
  const { service } = executor(new FakePlaceSearch(async () => returned.map((item) => structuredClone(item))));
  const result = await service.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: {
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'day-2:stop:1',
      replacementQuery: '瘦西湖',
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[1].places[0].placeId, 'amap:SCENIC');
  assert.equal(result.trip.days[1].places[0].placeName, '瘦西湖风景区');

  const { service: accessoryService } = executor(
    new FakePlaceSearch(async () => [structuredClone(scenic), structuredClone(pavilion)]),
  );
  const accessory = await accessoryService.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: {
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'day-2:stop:1',
      replacementQuery: '瘦西湖凉亭',
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(accessory.trip.days[1].places[0].placeId, 'amap:TING');
});

test('rebuilds scheduleItems only for the replaced day', async () => {
  const trip = sampleTrip();
  trip.days[0].scheduleItems = [{
    kind: 'experience',
    id: 'day-1:exp:keep',
    startTime: '12:00',
    durationMinutes: 60,
    type: 'meal',
    title: '午间休息与用餐',
    description: '在附近安排用餐和休息，按现场节奏调整。',
  }];
  const originalDay1 = structuredClone(trip.days[0].scheduleItems);
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.deepEqual(result.trip.days[0].scheduleItems, originalDay1);
  assert.ok((result.trip.days[1].scheduleItems?.length ?? 0) >= 2);
  const rebuilt = result.trip.days[1].scheduleItems ?? [];
  assert.equal(rebuilt.some((item) => item.kind === 'experience'), false);
  assert.equal(rebuilt.some((item) => item.kind === 'place' || item.kind === 'meal'), true);
  assert.equal(JSON.stringify(rebuilt).includes('自由活动'), false);
  assert.equal(JSON.stringify(result.summary).includes('GAP_FILL'), false);
});

test('selecting lunch keeps an existing dinner meal_place and stays complete', async () => {
  const temple = place({ id: 'amap:TEMPLE-LUNCH', name: '天坛公园', latitude: 39.882, longitude: 116.407 });
  const gate = place({ id: 'amap:GATE-LUNCH', name: '天安门', latitude: 39.907, longitude: 116.391 });
  const street = place({ id: 'amap:QIANMEN', name: '前门大街', latitude: 39.899, longitude: 116.398 });
  const trip = sampleTrip();
  const dinnerStop = tripPlace('day-1', 4, dinnerSpot, {
    startTime: '18:30',
    durationMinutes: 75,
    id: 'day-1:meal:dinner',
    type: 'restaurant',
    description: '晚餐安排。',
  });
  trip.days[0].places = [
    tripPlace('day-1', 1, gate, { startTime: '10:00', durationMinutes: 120 }),
    tripPlace('day-1', 2, temple, { startTime: '14:25', durationMinutes: 120 }),
    tripPlace('day-1', 3, street, { startTime: '16:50', durationMinutes: 90 }),
    dinnerStop,
  ];
  trip.days[0].places[0].transportToNext = {
    mode: 'taxi',
    durationMinutes: 36,
    distanceMeters: 5600,
  };
  trip.days[0].places[1].transportToNext = {
    mode: 'taxi',
    durationMinutes: 20,
    distanceMeters: 3200,
  };
  trip.days[0].places[2].transportToNext = {
    mode: 'walk',
    durationMinutes: 12,
    distanceMeters: 800,
  };
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    { kind: 'place', tripPlaceId: 'day-1:stop:3', startTime: '16:50', durationMinutes: 90 },
    {
      kind: 'meal_place',
      tripPlaceId: 'day-1:meal:dinner',
      mealPeriod: 'dinner',
      startTime: '18:30',
      durationMinutes: 75,
    },
  ];
  const before = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(trip.days[0].places.map((item) => item.id)),
    corePlaceCount: 3,
    items: trip.days[0].scheduleItems,
    places: trip.days[0].places,
  });
  assert.equal(before.valid, true, before.reason);
  const snapshot = structuredClone(trip);
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(lunchSpot)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  let result;
  try {
    result = await service.selectMealPlace({
      trip,
      places: catalog([lunchSpot, dinnerSpot, temple, gate, street]),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: lunchSpot.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    });
  } catch (error) {
    assert.ok(error instanceof TripChangeExecutionError);
    assert.fail(`lunch apply failed ${error.code} ${error.validationReason ?? 'no-reason'}`);
  }
  const items = result.trip.days[0].scheduleItems ?? [];
  const lunchItems = items.filter((item) => (
    (item.kind === 'meal_place' || item.kind === 'meal_slot') && item.mealPeriod === 'lunch'
  ));
  const dinnerItems = items.filter((item) => (
    (item.kind === 'meal_place' || item.kind === 'meal_slot') && item.mealPeriod === 'dinner'
  ));
  assert.equal(lunchItems.length, 1);
  assert.equal(lunchItems[0]?.kind, 'meal_place');
  assert.equal(dinnerItems.length, 1);
  assert.equal(dinnerItems[0]?.kind, 'meal_place');
  assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction').length, 3);
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === lunchSpot.id), true);
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === dinnerSpot.id), true);
  const lunchItem = items.find((item) => item.kind === 'meal_place' && item.mealPeriod === 'lunch');
  const nextCore = items.find((item) => item.kind === 'place' && item.tripPlaceId === 'day-1:stop:2');
  assert.ok(lunchItem && nextCore);
  const lunchEnd = (parseClockMinutes(lunchItem.startTime) ?? 0) + lunchItem.durationMinutes;
  assert.ok((parseClockMinutes(nextCore.startTime) ?? 0) >= lunchEnd);
  assert.deepEqual(trip, snapshot);
});

test('selecting lunch uses the same nearby dining search as the options sheet', async () => {
  const temple = place({ id: 'amap:TEMPLE-NEAR', name: '天坛公园', latitude: 39.882, longitude: 116.407 });
  const gate = place({ id: 'amap:GATE-NEAR', name: '天安门', latitude: 39.907, longitude: 116.391 });
  const street = place({ id: 'amap:QIANMEN-NEAR', name: '前门大街', latitude: 39.899, longitude: 116.398 });
  const sheetRestaurant = place({
    id: 'amap:SHEET-LUNCH',
    name: '陈记卤煮小肠',
    category: 'restaurant',
    latitude: 39.91,
    longitude: 116.4,
  });
  const otherRestaurant = place({
    id: 'amap:OTHER-LUNCH',
    name: '另一家餐厅',
    category: 'restaurant',
    latitude: 39.91,
    longitude: 116.4,
  });
  const trip = sampleTrip();
  const dinnerStop = tripPlace('day-1', 4, dinnerSpot, {
    startTime: '18:30',
    durationMinutes: 75,
    id: 'day-1:meal:dinner',
    type: 'restaurant',
    description: '晚餐安排。',
  });
  trip.days[0].places = [
    tripPlace('day-1', 1, gate, { startTime: '10:00', durationMinutes: 120 }),
    tripPlace('day-1', 2, temple, { startTime: '14:25', durationMinutes: 120 }),
    tripPlace('day-1', 3, street, { startTime: '16:50', durationMinutes: 90 }),
    dinnerStop,
  ];
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    { kind: 'place', tripPlaceId: 'day-1:stop:3', startTime: '16:50', durationMinutes: 90 },
    {
      kind: 'meal_place',
      tripPlaceId: 'day-1:meal:dinner',
      mealPeriod: 'dinner',
      startTime: '18:30',
      durationMinutes: 75,
    },
  ];
  const search: PlaceSearchService = {
    async search(input) {
      if (input.query.includes('附近')) {
        return [structuredClone(sheetRestaurant)];
      }
      return [structuredClone(otherRestaurant)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  let result;
  try {
    result = await service.selectMealPlace({
      trip,
      places: catalog([sheetRestaurant, otherRestaurant, dinnerSpot, temple, gate, street]),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: sheetRestaurant.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    });
  } catch (error) {
    assert.ok(error instanceof TripChangeExecutionError);
    assert.fail(`lunch apply failed ${error.code} ${error.validationReason ?? 'no-reason'}`);
  }
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === sheetRestaurant.id), true);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => (
    item.kind === 'meal_place' && item.mealPeriod === 'lunch'
  )), true);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => (
    item.kind === 'meal_place' && item.mealPeriod === 'dinner'
  )), true);
});

test('selecting a meal place on a three-core 2-hour day stays complete without extra cores', async () => {
  const temple = place({ id: 'amap:TEMPLE3', name: '天坛公园', latitude: 39.882, longitude: 116.407 });
  const gate = place({ id: 'amap:GATE', name: '天安门', latitude: 39.907, longitude: 116.391 });
  const palaceStop = place({ id: 'amap:PALACE2', name: '故宫', latitude: 39.916, longitude: 116.397 });
  const trip = sampleTrip();
  trip.days[0].places = [
    tripPlace('day-1', 1, gate, { startTime: '10:00', durationMinutes: 120 }),
    tripPlace('day-1', 2, palaceStop, { startTime: '14:25', durationMinutes: 120 }),
    tripPlace('day-1', 3, temple, { startTime: '17:00', durationMinutes: 90 }),
  ];
  trip.days[0].places[0].transportToNext = {
    mode: 'taxi',
    durationMinutes: 36,
    distanceMeters: 5600,
  };
  trip.days[0].places[1].transportToNext = {
    mode: 'taxi',
    durationMinutes: 26,
    distanceMeters: 4800,
  };
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    { kind: 'place', tripPlaceId: 'day-1:stop:3', startTime: '17:00', durationMinutes: 90 },
  ];
  const before = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(trip.days[0].places.map((item) => item.id)),
    corePlaceCount: 3,
    items: trip.days[0].scheduleItems,
    places: trip.days[0].places,
  });
  assert.equal(before.valid, true, before.reason);
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(lunchSpot)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  try {
    const result = await service.selectMealPlace({
      trip,
      places: catalog([lunchSpot, temple, gate, palaceStop]),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: lunchSpot.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    });
    assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction').length, 3);
    assert.equal(result.trip.days[0].scheduleItems?.filter((item) => item.kind === 'meal_place').length, 1);
    assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_slot' && item.mealPeriod === 'lunch'), false);
  } catch (error) {
    assert.ok(error instanceof TripChangeExecutionError);
    assert.fail(`meal apply failed ${error.code} ${error.validationReason ?? 'no-reason'}`);
  }
});

test('selecting a meal place keeps a valid two-core day without inventing a third attraction', async () => {
  const trip = sampleTrip();
  trip.days[0].places[0].durationMinutes = 120;
  trip.days[0].places[1].startTime = '14:25';
  trip.days[0].places[1].durationMinutes = 120;
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 120,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:25',
      durationMinutes: 120,
    },
    {
      kind: 'hotel_return',
      id: 'day-1:return:1',
      startTime: '16:40',
      durationMinutes: 45,
      title: '返程准备',
      description: '结束当天行程，预留返回住处的时间。',
    },
  ];
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(lunchSpot)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  await assert.rejects(
    () => service.selectMealPlace({
      trip,
      places: catalog([lunchSpot]),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: lunchSpot.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.validationReason, 'INVALID_TWO_PLACE_DAY');
      assert.equal(error.message.includes('INVALID_TWO_PLACE_DAY'), false);
      assert.equal(error.message, TRIP_CHANGE_INCOMPLETE_MESSAGE);
      return true;
    },
  );
});

function lowWalkingPlanningContext(): TripPlanningContextV1 {
  return {
    tripIntent: { interestKeys: ['history', 'culture_art'] },
    partyContext: {
      partyType: 'parents',
      hasElderly: true,
      mobilityRequirement: 'low_walking',
    },
    constraints: {
      excludedInterestKeys: [],
      lowWalking: true,
    },
  };
}

test('low-walking planningContext two-core days stay complete after meal apply', async () => {
  const trip = sampleTrip();
  trip.planningContext = lowWalkingPlanningContext();
  trip.days[0].places[0].durationMinutes = 120;
  trip.days[0].places[1].startTime = '14:25';
  trip.days[0].places[1].durationMinutes = 120;
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    {
      kind: 'hotel_return',
      id: 'day-1:return:1',
      startTime: '16:40',
      durationMinutes: 45,
      title: '返程准备',
      description: '结束当天行程，预留返回住处的时间。',
    },
  ];
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(lunchSpot)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  const result = await service.selectMealPlace({
    trip,
    places: catalog([lunchSpot]),
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: lunchSpot.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction').length, 2);
  assert.equal(result.trip.planningContext?.partyContext?.partyType, 'parents');
  assert.equal(result.summary.type, 'SELECT_MEAL_PLACE');
  const afterMeal = validateDayItineraryCompleteness({
    pace: result.trip.pace,
    targetCorePlacesPerDay: 2,
    placeIds: new Set(result.trip.days[0].places.map((item) => item.id)),
    corePlaceCount: 2,
    items: result.trip.days[0].scheduleItems ?? [],
    places: result.trip.days[0].places,
  });
  assert.equal(afterMeal.valid, true, afterMeal.reason);
});

test('low-walking planningContext two-core days stay complete after replace place', async () => {
  const trip = sampleTrip();
  trip.planningContext = lowWalkingPlanningContext();
  trip.days[0].places[0].durationMinutes = 120;
  trip.days[0].places[1].startTime = '14:25';
  trip.days[0].places[1].durationMinutes = 120;
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    {
      kind: 'hotel_return',
      id: 'day-1:return:1',
      startTime: '16:40',
      durationMinutes: 45,
      title: '返程准备',
      description: '结束当天行程，预留返回住处的时间。',
    },
  ];
  const nearby = place({
    id: 'amap:NEAR',
    name: '劳动人民文化宫',
    latitude: 39.913,
    longitude: 116.403,
  });
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(nearby)]));
  const result = await service.replacePlace({
    trip,
    places: catalog([nearby]),
    operation: {
      type: 'REPLACE_PLACE',
      dayNumber: 1,
      targetTripPlaceId: 'day-1:stop:2',
      replacementQuery: '劳动人民文化宫',
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[0].places.filter((item) => (
    item.type === 'attraction' || item.type === 'activity'
  )).length, 2);
  assert.equal(result.summary.type, 'REPLACE_PLACE');
  const afterReplace = validateDayItineraryCompleteness({
    pace: result.trip.pace,
    targetCorePlacesPerDay: 2,
    placeIds: new Set(result.trip.days[0].places.map((item) => item.id)),
    corePlaceCount: 2,
    items: result.trip.days[0].scheduleItems ?? [],
    places: result.trip.days[0].places,
  });
  assert.equal(afterReplace.valid, true, afterReplace.reason);
});


test('selecting a meal place does not fail when search cannot invent another core attraction', async () => {
  const trip = sampleTrip();
  trip.days[0].places[1].startTime = '14:30';
  trip.days[0].places[1].durationMinutes = 180;
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:30',
      durationMinutes: 180,
    },
    {
      kind: 'hotel_return',
      id: 'day-1:return:1',
      startTime: '17:00',
      durationMinutes: 30,
      title: '返程准备',
      description: '结束当天行程，返回住处。',
    },
  ];
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(lunchSpot)];
    },
  };
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(new FakeRouteService()));
  const result = await service.selectMealPlace({
    trip,
    places: catalog([lunchSpot]),
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: lunchSpot.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction').length, 2);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_place'), true);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_slot' && item.mealPeriod === 'lunch'), false);
});

test('selecting a meal place on a three-core balanced day replaces the slot and stays complete', async () => {
  const temple = place({ id: 'amap:TEMPLE', name: '天坛公园', latitude: 39.882, longitude: 116.407 });
  const trip = sampleTrip();
  trip.days[0].places = [
    tripPlace('day-1', 1, palace, { startTime: '10:00', durationMinutes: 90 }),
    tripPlace('day-1', 2, park, { startTime: '14:25', durationMinutes: 90 }),
    tripPlace('day-1', 3, temple, { startTime: '16:30', durationMinutes: 90 }),
  ];
  trip.days[0].places[0].transportToNext = {
    mode: 'taxi',
    durationMinutes: 20,
    distanceMeters: 4000,
  };
  trip.days[0].places[1].transportToNext = {
    mode: 'taxi',
    durationMinutes: 18,
    distanceMeters: 3600,
  };
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:25',
      durationMinutes: 90,
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:3',
      startTime: '16:30',
      durationMinutes: 90,
    },
  ];
  trip.routes = [routeBetween('day-1', trip.days[0].places[0], trip.days[0].places[1], 1)];
  const snapshot = structuredClone(trip);
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(lunchSpot)]));
  const result = await service.selectMealPlace({
    trip,
    places: catalog([lunchSpot, temple]),
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: lunchSpot.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  const kinds = result.trip.days[0].scheduleItems?.map((item) => item.kind) ?? [];
  assert.equal(result.summary.type, 'SELECT_MEAL_PLACE');
  assert.equal(kinds.filter((kind) => kind === 'meal_slot').length, 0);
  assert.equal(kinds.filter((kind) => kind === 'meal_place').length, 1);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => (
    item.kind === 'meal_place' && item.mealPeriod === 'lunch' && item.tripPlaceId === 'day-1:meal:lunch'
  )), true);
  assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction' || item.type === 'activity').length, 3);
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === lunchSpot.id), true);
  assert.equal(result.places.some((item) => item.id === lunchSpot.id), true);
  assert.deepEqual(trip, snapshot);
});

test('selecting a meal place replaces a flexible slot and recalculates the day', async () => {
  const trip = sampleTrip();
  trip.days[0].places[1].startTime = '14:30';
  trip.days[0].places[1].durationMinutes = 180;
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:30',
      durationMinutes: 180,
    },
  ];
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(lunchSpot)]));
  const result = await service.selectMealPlace({
    trip,
    places: catalog([lunchSpot]),
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: lunchSpot.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.summary.type, 'SELECT_MEAL_PLACE');
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === lunchSpot.id), true);
  assert.equal(result.trip.days[0].places.filter((item) => item.type === 'attraction').length, 2);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_slot' && item.mealPeriod === 'lunch'), false);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => item.kind === 'meal_place' && item.mealPeriod === 'lunch'), true);
  assert.equal(result.places.some((item) => item.id === lunchSpot.id), true);
});

test('selectMealPlace rejects self_managed slots and non-dining candidates without leaking internals', async () => {
  const trip = sampleTrip();
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'self_managed',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:30',
      durationMinutes: 180,
    },
  ];
  const snapshot = structuredClone(trip);
  const { search, routes, service } = executor(new FakePlaceSearch(async () => [structuredClone(lunchSpot)]));
  await expectInvalid(
    () => service.selectMealPlace({
      trip,
      places: catalog([lunchSpot]),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: lunchSpot.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    search,
    routes,
  );
  assert.deepEqual(trip, snapshot);

  const flexible = sampleTrip();
  flexible.days[0].places[1].durationMinutes = 180;
  flexible.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:1',
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    {
      kind: 'place',
      tripPlaceId: 'day-1:stop:2',
      startTime: '14:30',
      durationMinutes: 180,
    },
  ];
  const attractionOnly: PlaceSearchService = {
    async search() {
      return [structuredClone(palace)];
    },
  };
  const diningService = new AmapTripChangeExecutor(
    attractionOnly,
    new AmapTripRouteEnricher(new FakeRouteService()),
  );
  await assert.rejects(
    () => diningService.selectMealPlace({
      trip: flexible,
      places: catalog(),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        placeId: palace.id,
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.message.includes('MISSING'), false);
      return true;
    },
  );
});

test('replacePlace rejects a bus stop for a sight query and keeps generation alignment', async () => {
  const bus = place({ id: 'amap:BUS', name: '大明寺(公交站)', category: 'transport' });
  const temple = place({ id: 'amap:TEMPLE', name: '大明寺' });
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(bus), structuredClone(temple)]));
  const result = await service.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: {
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'day-2:stop:1',
      replacementQuery: '大明寺',
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[1].places[0].placeId, 'amap:TEMPLE');

  const { service: onlyBus } = executor(new FakePlaceSearch(async () => [structuredClone(bus)]));
  await assert.rejects(
    () => onlyBus.replacePlace({
      trip: sampleTrip(),
      places: catalog(),
      operation: {
        type: 'REPLACE_PLACE',
        dayNumber: 2,
        targetTripPlaceId: 'day-2:stop:1',
        replacementQuery: '大明寺',
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.message.includes('公交站'), false);
      assert.equal(error.message.includes('大明寺'), false);
      return true;
    },
  );
});

test('skips Place ids already used on the same day or another day and picks the next candidate', async () => {
  const { service: sameDay } = executor(
    new FakePlaceSearch(async () => [structuredClone(stadium), structuredClone(summer)]),
  );
  const sameDayResult = await sameDay.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(sameDayResult.trip.days[1].places[0].placeId, 'amap:SUMMER');

  const { service: otherDay } = executor(
    new FakePlaceSearch(async () => [structuredClone(palace), structuredClone(summer)]),
  );
  const otherDayResult = await otherDay.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(otherDayResult.trip.days[1].places[0].placeId, 'amap:SUMMER');
});

test('throws TRIP_CHANGE_INCOMPLETE when no unused candidate remains and does not plan routes', async () => {
  const trip = sampleTrip();
  const snapshot = structuredClone(trip);
  const { search, routes, service } = executor(
    new FakePlaceSearch(async () => [structuredClone(palace), structuredClone(stadium)]),
  );

  await assert.rejects(
    () => service.replacePlace({
      trip,
      places: catalog(),
      operation: replaceWallOp(),
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.message, TRIP_CHANGE_INCOMPLETE_MESSAGE);
      assert.equal(error.message.includes('颐和园'), false);
      return true;
    },
  );
  assert.deepEqual(trip, snapshot);
  assert.equal(search.calls.length, 1);
  assert.equal(routes.calls.length, 0);
});

test('rejects illegal operations and trip input before any provider call', async () => {
  const { search, routes, service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const trip = sampleTrip();
  const places = catalog();
  const updatedAt = '2026-09-16T12:00:00.000Z';

  await expectInvalid(
    () => service.replacePlace({
      trip,
      places,
      operation: {
        type: 'REMOVE_PLACE',
        dayNumber: 2,
        targetTripPlaceId: 'day-2:stop:1',
      } as never,
      updatedAt,
    }),
    search,
    routes,
  );
  await expectInvalid(
    () => service.replacePlace({
      trip,
      places,
      operation: { ...replaceWallOp(), dayNumber: 2, targetTripPlaceId: 'day-1:stop:1' },
      updatedAt,
    }),
    search,
    routes,
  );
  await expectInvalid(
    () => service.replacePlace({
      trip,
      places,
      operation: { ...replaceWallOp(), replacementQuery: '   ' },
      updatedAt,
    }),
    search,
    routes,
  );
  await expectInvalid(
    () => service.replacePlace({
      trip,
      places,
      operation: { ...replaceWallOp(), targetTripPlaceId: 'missing-stop' },
      updatedAt,
    }),
    search,
    routes,
  );
  await expectInvalid(
    () => service.replacePlace({
      trip,
      places: catalog().filter((item) => item.id !== wall.id),
      operation: replaceWallOp(),
      updatedAt,
    }),
    search,
    routes,
  );

  const brokenTrip = sampleTrip();
  brokenTrip.days[0].places[0].placeId = 'amap:MISSING';
  await expectInvalid(
    () => service.replacePlace({
      trip: brokenTrip,
      places,
      operation: replaceWallOp(),
      updatedAt,
    }),
    search,
    routes,
  );

  const duplicatePlaces = catalog([place({ id: 'amap:PALACE', name: '重复故宫' })]);
  await expectInvalid(
    () => service.replacePlace({
      trip: sampleTrip(),
      places: duplicatePlaces,
      operation: replaceWallOp(),
      updatedAt,
    }),
    search,
    routes,
  );

  await expectInvalid(
    () => service.replacePlace({
      trip: sampleTrip(),
      places,
      operation: replaceWallOp(),
      updatedAt: 'not-iso',
    }),
    search,
    routes,
  );
});

test('keeps place provider failures as PROVIDER_ERROR or PROVIDER_UNAVAILABLE', async () => {
  const trip = sampleTrip();
  const snapshot = structuredClone(trip);
  const errorSearch = new FakePlaceSearch(async () => {
    throw new AmapProviderError('PROVIDER_ERROR', 'https://restapi.amap.com/v3/place/text?key=secret');
  });
  const { routes, service } = executor(errorSearch);
  await assert.rejects(
    () => service.replacePlace({
      trip,
      places: catalog(),
      operation: replaceWallOp(),
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, TRIP_CHANGE_PROVIDER_ERROR_MESSAGE);
      assert.equal(error.message.includes('amap'), false);
      assert.equal(error.message.includes('secret'), false);
      return true;
    },
  );
  assert.deepEqual(trip, snapshot);
  assert.equal(routes.calls.length, 0);

  const unavailableSearch = new FakePlaceSearch(async () => {
    throw new AmapProviderError('PROVIDER_UNAVAILABLE', 'missing key');
  });
  const unavailable = executor(unavailableSearch);
  await assert.rejects(
    () => unavailable.service.replacePlace({
      trip: sampleTrip(),
      places: catalog(),
      operation: replaceWallOp(),
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.message, TRIP_CHANGE_PROVIDER_UNAVAILABLE_MESSAGE);
      return true;
    },
  );
});

test('recalculates only the affected day routes and drops routes that still point at the old place', async () => {
  const trip = sampleTrip();
  const { routes, service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.ok(routes.calls.length >= 1);
  assert.equal(routes.calls[0].origin.latitude, summer.latitude);
  assert.equal(routes.calls[0].destination.latitude, stadium.latitude);
  const day2Routes = result.trip.routes.filter((item) => item.dayId === 'day-2');
  assert.ok(day2Routes.length >= 1);
  assert.equal(day2Routes[0].fromTripPlaceId, 'day-2:stop:1');
  assert.equal(
    result.trip.days[1].places[0].placeId !== 'amap:WALL',
    true,
  );
  assert.equal(
    result.trip.routes.some((item) => (
      item.fromTripPlaceId === 'day-2:stop:1' && item.dayId === 'day-2'
    )),
    true,
  );
  const referenced = new Set(result.trip.days.flatMap((day) => day.places.map((item) => item.placeId)));
  assert.equal(referenced.has('amap:WALL'), false);
  assert.deepEqual(
    result.trip.routes.filter((item) => item.dayId === 'day-1'),
    trip.routes.filter((item) => item.dayId === 'day-1'),
  );
});

test('does not invent transport, distance or polyline when route planning fails', async () => {
  const failingRoutes = new FakeRouteService(async () => {
    throw new AmapProviderError('PROVIDER_ERROR', 'upstream timeout');
  });
  const { service } = executor(
    new FakePlaceSearch(async () => [structuredClone(summer)]),
    failingRoutes,
  );
  const result = await service.replacePlace({
    trip: sampleTrip(),
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.routes.filter((item) => item.dayId === 'day-2').length, 0);
  assert.equal(result.trip.days[1].places[0].transportToNext, undefined);
  assert.equal(result.summary.routeRecalculated, true);
  assert.equal(result.trip.days[1].places[0].placeId, 'amap:SUMMER');
});

test('reschedules the affected day continuously and leaves other day times unchanged', async () => {
  const trip = sampleTrip();
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.trip.days[0].places[0].startTime, '10:00');
  assert.equal(result.trip.days[0].places[1].startTime, '12:00');
  assert.equal(result.trip.days[1].places[0].startTime, '10:00');
  assert.notEqual(result.trip.days[1].places[0].startTime, '19:30');
  assert.ok(result.trip.days[1].places.length >= 3);
  const starts = result.trip.days[1].places.map((place) => place.startTime);
  assert.equal(new Set(starts).size, starts.length);
  assert.ok((result.trip.days[1].places[1].startTime ?? '') > '11:30');
});

test('returns unique cloned places actually referenced by the new trip in first-seen order', async () => {
  const trip = sampleTrip();
  const inputPlaces = catalog();
  const { service } = executor(new FakePlaceSearch(async () => [structuredClone(summer)]));
  const result = await service.replacePlace({
    trip,
    places: inputPlaces,
    operation: replaceWallOp(),
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  const ids = result.places.map((item) => item.id);
  assert.deepEqual(ids.slice(0, 4), ['amap:PALACE', 'amap:PARK', 'amap:SUMMER', 'amap:STADIUM']);
  assert.equal(ids.includes('amap:UNUSED'), true);
  assert.equal(ids.includes('amap:LUNCH'), false);
  assert.equal(result.places.some((item) => item.id === 'amap:WALL'), false);
  const summerCopy = result.places.find((item) => item.id === 'amap:SUMMER');
  assert.ok(summerCopy);
  summerCopy.name = '被改名';
  assert.equal(summer.name, '颐和园');
  assert.equal(inputPlaces.find((item) => item.id === 'amap:UNUSED')?.name, '圆明园');
  assert.notEqual(result.places[0], inputPlaces[0]);
});

test('selectMealPlace resolves sheet candidate by stable place id without catalog or re-search', async () => {
  const temple = place({ id: 'amap:TEMPLE-ID', name: '天坛公园', latitude: 39.882, longitude: 116.407 });
  const gate = place({ id: 'amap:GATE-ID', name: '天安门', latitude: 39.907, longitude: 116.391 });
  const street = place({ id: 'amap:STREET-ID', name: '前门大街', latitude: 39.899, longitude: 116.398 });
  const sheetRestaurant = place({
    id: 'amap:SHEET-BY-ID',
    name: '灵隐寺附近面馆',
    category: 'restaurant',
    latitude: 39.91,
    longitude: 116.4,
  });
  const trip = sampleTrip();
  trip.days[0].places = [
    tripPlace('day-1', 1, gate, { startTime: '10:00', durationMinutes: 120 }),
    tripPlace('day-1', 2, temple, { startTime: '14:25', durationMinutes: 120 }),
    tripPlace('day-1', 3, street, { startTime: '16:50', durationMinutes: 90 }),
  ];
  trip.days[0].scheduleItems = [
    { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
    {
      kind: 'meal_slot',
      id: 'day-1:meal:lunch',
      mealPeriod: 'lunch',
      startTime: '12:15',
      durationMinutes: 75,
      areaTripPlaceId: 'day-1:stop:1',
      nextTripPlaceId: 'day-1:stop:2',
      diningMode: 'flexible',
    },
    { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:25', durationMinutes: 120 },
    { kind: 'place', tripPlaceId: 'day-1:stop:3', startTime: '16:50', durationMinutes: 90 },
  ];
  const snapshot = structuredClone(trip);
  const coreBefore = trip.days[0].places.filter((item) => item.type === 'attraction').length;
  const search = new FakePlaceSearch(
    async () => {
      assert.fail('meal apply must not re-search when stable id resolves');
      return [];
    },
    async (providerPlaceId) => {
      assert.equal(providerPlaceId, 'SHEET-BY-ID');
      return structuredClone(sheetRestaurant);
    },
  );
  const routes = new FakeRouteService();
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(routes));
  const result = await service.selectMealPlace({
    trip,
    places: [gate, temple, street, wall, stadium].map((item) => structuredClone(item)),
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: sheetRestaurant.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.deepEqual(trip, snapshot);
  assert.equal(search.calls.length, 0);
  assert.equal(search.detailCalls.length, 1);
  assert.ok(routes.calls.length >= 1);
  assert.equal(result.trip.days[0].places.some((item) => item.placeId === sheetRestaurant.id), true);
  assert.equal(
    result.trip.days[0].places.filter((item) => item.type === 'attraction').length,
    coreBefore,
  );
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => (
    item.kind === 'meal_place' && item.mealPeriod === 'lunch'
  )), true);
  assert.equal(result.trip.days[0].scheduleItems?.some((item) => (
    item.kind === 'meal_slot' && item.id === 'day-1:meal:lunch'
  )), false);
  assert.equal(result.summary.routeRecalculated, true);
});

test('replacePlace resolves candidate confirmation by stable place id without name re-search', async () => {
  const museum = place({
    id: 'amap:ZHEJIANG-MUSEUM',
    name: '浙江省博物馆(孤山馆区)',
    latitude: 30.253,
    longitude: 120.139,
  });
  const search = new FakePlaceSearch(
    async (input) => {
      assert.notEqual(input.query, museum.name);
      assert.notEqual(input.query, museum.id);
      return [structuredClone(unused)];
    },
    async (providerPlaceId) => {
      assert.equal(providerPlaceId, 'ZHEJIANG-MUSEUM');
      return structuredClone(museum);
    },
  );
  const routes = new FakeRouteService();
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(routes));
  const trip = sampleTrip();
  const snapshot = structuredClone(trip);
  const result = await service.replacePlace({
    trip,
    places: catalog(),
    operation: {
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'day-2:stop:1',
      replacementQuery: museum.id,
    },
    updatedAt: '2026-09-16T12:00:00.000Z',
  });
  assert.deepEqual(trip, snapshot);
  assert.equal(search.detailCalls.length, 1);
  assert.equal(search.calls.some((call) => call.query === museum.name || call.query === museum.id), false);
  assert.ok(routes.calls.length >= 1);
  assert.equal(result.trip.days[1].places[0].placeId, museum.id);
  assert.equal(result.trip.days[1].places[0].placeName, museum.name);
  assert.equal(result.summary.nextPlaceName, museum.name);
  assert.equal(result.summary.routeRecalculated, true);
});

test('stable place id miss keeps trip unchanged with NO_MATCH validationReason', async () => {
  const search = new FakePlaceSearch(
    async () => [structuredClone(summer)],
    async () => null,
  );
  const routes = new FakeRouteService();
  const service = new AmapTripChangeExecutor(search, new AmapTripRouteEnricher(routes));
  const trip = sampleTrip();
  const snapshot = structuredClone(trip);
  await assert.rejects(
    () => service.replacePlace({
      trip,
      places: catalog(),
      operation: {
        type: 'REPLACE_PLACE',
        dayNumber: 2,
        targetTripPlaceId: 'day-2:stop:1',
        replacementQuery: 'amap:MISSING-POI',
      },
      updatedAt: '2026-09-16T12:00:00.000Z',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripChangeExecutionError);
      assert.equal(error.code, 'TRIP_CHANGE_INCOMPLETE');
      assert.equal(error.validationReason, 'NO_MATCH');
      assert.equal(error.message, TRIP_CHANGE_INCOMPLETE_MESSAGE);
      return true;
    },
  );
  assert.deepEqual(trip, snapshot);
  assert.equal(search.calls.length, 0);
  assert.equal(routes.calls.length, 0);
});
