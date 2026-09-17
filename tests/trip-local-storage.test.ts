import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Place, Trip } from '../src/domain/trip/types';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { LocalStorageTripRepository } from '../src/repositories/local-storage-trip-repository';
import {
  consumeTripPersistenceNotice,
  MAX_STORED_DAYS,
  MAX_STORED_POLYLINE_POINTS,
  MAX_STORED_STOPS_PER_DAY,
  parseTripRepositoryStore,
  readTripRepositoryStore,
  selectRecentTrips,
  serializeTripRepositoryStore,
  TRIP_REPOSITORY_STORAGE_KEY,
  TRIP_SESSION_ONLY_NOTICE,
  type TripStorage,
} from '../src/repositories/local-trip-storage';
import { MockTripRepository } from '../src/repositories/mock-trip-repository';
import { referencedPlaceIdsInTripOrder } from '../src/repositories/trip-repository';
import {
  persistAppliedTripChange,
  restoreTripChangeSnapshot,
} from '../src/services/trip-change-service';

class MemoryStorage implements TripStorage {
  readonly values = new Map<string, string>();

  constructor(private readonly throwsOn?: 'get' | 'set') {}

  getItem(key: string): string | null {
    if (this.throwsOn === 'get') {
      throw new Error('blocked');
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwsOn === 'set') {
      throw new Error('quota');
    }
    this.values.set(key, value);
  }
}

function samplePlace(id = 'place-a', name = '故宫'): Place {
  return {
    id,
    provider: 'amap',
    providerPlaceId: `amap-${id}`,
    name,
    address: '北京市东城区',
    latitude: 39.916,
    longitude: 116.397,
    category: 'attraction',
  };
}

function sampleTrip(id: string, destination: string, updatedAt: string, place = samplePlace()): Trip {
  const dayId = `${id}-day-1`;
  return {
    id,
    userId: 'user-demo-001',
    title: `${destination} · 1天`,
    destination,
    travelerCount: 2,
    totalBudget: 1800,
    currency: 'CNY',
    pace: 'relaxed',
    preferences: { interests: ['博物馆'] },
    status: 'READY',
    days: [{
      id: dayId,
      tripId: id,
      dayNumber: 1,
      date: '2026-10-01',
      places: [{
        id: `${id}-stop-1`,
        dayId,
        order: 1,
        placeId: place.id,
        placeName: place.name,
        type: 'attraction',
        estimatedCost: 60,
      }],
    }],
    routes: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
  };
}

function shanghaiPlaces(): Place[] {
  return referencedPlaceIdsInTripOrder(mockShanghaiTrip).map((placeId) => (
    structuredClone(mockPlaces.find((place) => place.id === placeId)!)
  ));
}

function resetNotice(): void {
  consumeTripPersistenceNotice();
}

test('empty storage starts with mock seed trips and does not write', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const trips = await repository.getTripsByUserId('user-demo-001');
  assert.ok(trips.some((trip) => trip.id === mockShanghaiTrip.id));
  assert.equal(storage.values.has(TRIP_REPOSITORY_STORAGE_KEY), false);
  assert.equal(await repository.getTripById('missing'), null);
});

test('saved generated trip and places restore in a new repository instance', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const place = samplePlace('place-live', '圆明园');
  const trip = sampleTrip('trip-live', '北京', '2026-09-16T08:00:00.000Z', place);
  const first = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await first.saveGeneratedTrip({ trip, places: [place, samplePlace('place-extra', '未引用')] });
  const raw = storage.values.get(TRIP_REPOSITORY_STORAGE_KEY);
  assert.equal(typeof raw, 'string');
  assert.equal(raw?.includes('place-extra'), false);
  assert.equal(JSON.parse(raw!).version, 1);

  const restored = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const loaded = await restored.getTripById('trip-live');
  const places = await restored.getPlacesForTrip('trip-live');
  assert.equal(loaded?.destination, '北京');
  assert.deepEqual(places.map((item) => item.id), ['place-live']);
  assert.equal(places[0].name, '圆明园');
  assert.equal(places[0].provider, 'amap');
});

test('restores scheduleItems and still loads older trips without them', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const place = samplePlace('place-live', '圆明园');
  const trip = sampleTrip('trip-schedule', '北京', '2026-09-16T08:00:00.000Z', place);
  trip.days[0].places[0].startTime = '10:00';
  trip.days[0].places[0].durationMinutes = 90;
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: trip.days[0].places[0].id,
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'experience',
      id: `${trip.days[0].id}:exp:1`,
      startTime: '12:00',
      durationMinutes: 60,
      type: 'meal',
      title: '午间休息与用餐',
      description: '在附近安排用餐和休息，按现场节奏调整。',
    },
  ];
  const first = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await first.saveGeneratedTrip({ trip, places: [place] });
  const restored = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const loaded = await restored.getTripById('trip-schedule');
  assert.equal(loaded?.days[0].scheduleItems?.length, 2);
  assert.equal(loaded?.days[0].scheduleItems?.[1]?.kind, 'experience');
  assert.equal(JSON.stringify(loaded).includes('prompt'), false);

  const legacy = sampleTrip('trip-legacy', '西安', '2026-09-16T09:00:00.000Z', place);
  await restored.saveGeneratedTrip({ trip: legacy, places: [place] });
  const loadedLegacy = await restored.getTripById('trip-legacy');
  assert.equal(loadedLegacy?.days[0].scheduleItems, undefined);
  await restored.deleteTrip('trip-schedule');
  assert.equal(await restored.getTripById('trip-schedule'), null);
});

test('restores meal and rest schedule items and skips broken references', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const place = samplePlace('place-live', '圆明园');
  const lunch = samplePlace('place-lunch', '附近餐厅');
  lunch.category = 'restaurant';
  const trip = sampleTrip('trip-meal', '北京', '2026-09-16T08:00:00.000Z', place);
  trip.days[0].places.push({
    id: `${trip.days[0].id}:stop:2`,
    dayId: trip.days[0].id,
    order: 2,
    placeId: lunch.id,
    placeName: lunch.name,
    type: 'restaurant',
    estimatedCost: 0,
    startTime: '12:00',
    durationMinutes: 60,
  });
  trip.days[0].scheduleItems = [
    {
      kind: 'place',
      tripPlaceId: trip.days[0].places[0].id,
      startTime: '10:00',
      durationMinutes: 90,
    },
    {
      kind: 'meal',
      tripPlaceId: trip.days[0].places[1].id,
      startTime: '12:00',
      durationMinutes: 60,
      mealPeriod: 'lunch',
    },
    {
      kind: 'rest',
      id: `${trip.days[0].id}:rest:1`,
      startTime: '13:15',
      durationMinutes: 30,
      title: '午间休息',
      description: '稍作休息，再继续下一项安排。',
    },
    {
      kind: 'meal',
      tripPlaceId: 'missing-stop',
      startTime: '18:00',
      durationMinutes: 60,
      mealPeriod: 'dinner',
    },
  ];
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await repository.saveGeneratedTrip({ trip, places: [place, lunch] });
  const loaded = await new LocalStorageTripRepository(new MockTripRepository(), storage).getTripById('trip-meal');
  assert.equal(loaded?.days[0].scheduleItems?.some((item) => item.kind === 'meal'), true);
  assert.equal(loaded?.days[0].scheduleItems?.some((item) => item.kind === 'meal' && item.kind === 'meal' && item.tripPlaceId === 'missing-stop'), false);
  assert.equal(JSON.stringify(loaded).includes('MISSING_LUNCH'), false);
});

test('persists flexible meal slots and selected meal places', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const place = samplePlace('place-live', '东四');
  const lunch = samplePlace('place-lunch', '东四小馆');
  lunch.category = 'restaurant';
  const trip = sampleTrip('trip-slot', '北京', '2026-09-16T08:00:00.000Z', place);
  trip.days[0].scheduleItems = [{
    kind: 'meal_slot',
    id: `${trip.days[0].id}:meal:lunch`,
    mealPeriod: 'lunch',
    startTime: '11:45',
    durationMinutes: 75,
    areaTripPlaceId: trip.days[0].places[0].id,
    diningMode: 'flexible',
  }];
  const first = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await first.saveGeneratedTrip({ trip, places: [place] });
  const reloaded = await new LocalStorageTripRepository(new MockTripRepository(), storage).getTripById('trip-slot');
  assert.equal(reloaded?.days[0].scheduleItems?.[0]?.kind, 'meal_slot');
  trip.days[0].places.push({
    id: `${trip.days[0].id}:meal:lunch`,
    dayId: trip.days[0].id,
    order: 2,
    placeId: lunch.id,
    placeName: lunch.name,
    type: 'restaurant',
    estimatedCost: 0,
    startTime: '11:45',
    durationMinutes: 75,
  });
  trip.days[0].scheduleItems = [{
    kind: 'meal_place',
    tripPlaceId: `${trip.days[0].id}:meal:lunch`,
    mealPeriod: 'lunch',
    startTime: '11:45',
    durationMinutes: 75,
  }];
  await first.saveGeneratedTrip({ trip, places: [place, lunch] });
  const selected = await new LocalStorageTripRepository(new MockTripRepository(), storage).getTripById('trip-slot');
  assert.equal(selected?.days[0].scheduleItems?.[0]?.kind, 'meal_place');
  assert.equal(JSON.stringify(selected).includes('评分'), false);
});


test('multiple trips persist independently, sort by updatedAt, and delete one without the other', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const olderPlace = samplePlace('place-hangzhou', '西湖');
  const newerPlace = samplePlace('place-suzhou', '拙政园');
  const older = sampleTrip('trip-hangzhou-live', '杭州', '2026-09-10T00:00:00.000Z', olderPlace);
  const newer = sampleTrip('trip-suzhou-live', '苏州', '2026-09-16T12:00:00.000Z', newerPlace);
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await repository.saveGeneratedTrip({ trip: older, places: [olderPlace] });
  await repository.saveGeneratedTrip({ trip: newer, places: [newerPlace] });

  const recent = selectRecentTrips(await repository.getTripsByUserId('user-demo-001'));
  assert.equal(recent[0].id, 'trip-suzhou-live');
  assert.ok(recent.some((trip) => trip.id === mockShanghaiTrip.id));

  await repository.deleteTrip('trip-hangzhou-live');
  const after = new LocalStorageTripRepository(new MockTripRepository(), storage);
  assert.equal(await after.getTripById('trip-hangzhou-live'), null);
  assert.equal((await after.getPlacesForTrip('trip-hangzhou-live')).length, 0);
  assert.equal((await after.getTripById('trip-suzhou-live'))?.destination, '苏州');
  assert.equal((await after.getPlacesForTrip('trip-suzhou-live'))[0].name, '拙政园');
  assert.ok(await after.getTripById(mockShanghaiTrip.id));
});

test('deleting a mock seed remembers removal without rewriting other seeds into storage', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  await repository.deleteTrip(mockShanghaiTrip.id);
  const stored = JSON.parse(storage.values.get(TRIP_REPOSITORY_STORAGE_KEY)!);
  assert.deepEqual(stored.removedSeedIds, [mockShanghaiTrip.id]);
  assert.equal(stored.records.some((record: { trip: Trip }) => record.trip.id === mockShanghaiTrip.id), false);

  const restored = new LocalStorageTripRepository(new MockTripRepository(), storage);
  assert.equal(await restored.getTripById(mockShanghaiTrip.id), null);
  assert.ok(await restored.getTripById('trip-hangzhou-autumn'));
});

test('missing referenced places, corrupt json, wrong version and unknown keys are skipped safely', () => {
  const trip = sampleTrip('trip-ok', '南京', '2026-09-16T00:00:00.000Z');
  const place = samplePlace();
  const validRecord = JSON.parse(serializeTripRepositoryStore({
    version: 1,
    records: [{ trip, places: [place] }],
    removedSeedIds: [],
  })).records[0];

  assert.equal(parseTripRepositoryStore({ version: 2, records: [validRecord] }), undefined);
  assert.equal(parseTripRepositoryStore({ version: 1, records: [validRecord], extra: true }), undefined);
  assert.equal(readTripRepositoryStore({
    getItem() { return '{'; },
    setItem() {},
  }).records.length, 0);

  const missingPlace = parseTripRepositoryStore({
    version: 1,
    records: [{ trip: validRecord.trip, places: [] }],
  });
  assert.equal(missingPlace?.records.length, 0);

  const mixed = parseTripRepositoryStore({
    version: 1,
    records: [
      { trip: { ...validRecord.trip, id: 'broken' }, places: [] },
      validRecord,
    ],
  });
  assert.equal(mixed?.records.length, 1);
  assert.equal(mixed?.records[0].trip.id, 'trip-ok');

  const tooManyStops = structuredClone(validRecord);
  tooManyStops.trip.days[0].places = Array.from({ length: MAX_STORED_STOPS_PER_DAY + 1 }, (_, index) => ({
    ...validRecord.trip.days[0].places[0],
    id: `stop-${index}`,
    order: index + 1,
  }));
  assert.equal(parseTripRepositoryStore({ version: 1, records: [tooManyStops] })?.records.length, 0);

  const tooManyDays = structuredClone(validRecord);
  tooManyDays.trip.days = Array.from({ length: MAX_STORED_DAYS + 1 }, (_, index) => ({
    ...validRecord.trip.days[0],
    id: `day-${index}`,
    dayNumber: index + 1,
  }));
  assert.equal(parseTripRepositoryStore({ version: 1, records: [tooManyDays] })?.records.length, 0);

  const longLine = structuredClone(validRecord);
  longLine.trip.routes = [{
    id: 'route-1',
    dayId: validRecord.trip.days[0].id,
    fromTripPlaceId: validRecord.trip.days[0].places[0].id,
    toTripPlaceId: validRecord.trip.days[0].places[0].id,
    transport: { mode: 'walk', durationMinutes: 10, distanceMeters: 800 },
    polyline: Array.from({ length: MAX_STORED_POLYLINE_POINTS + 1 }, () => ({ latitude: 39.9, longitude: 116.4 })),
  }];
  assert.equal(parseTripRepositoryStore({ version: 1, records: [longLine] })?.records.length, 0);
});

test('storage getItem and setItem errors keep the repository usable', async () => {
  resetNotice();
  const unreadable = new LocalStorageTripRepository(new MockTripRepository(), new MemoryStorage('get'));
  assert.ok(await unreadable.getTripById(mockShanghaiTrip.id));

  const storage = new MemoryStorage('set');
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const trip = sampleTrip('trip-session', '西安', '2026-09-16T00:00:00.000Z');
  const saved = await repository.saveGeneratedTrip({ trip, places: [samplePlace()] });
  assert.equal(saved.destination, '西安');
  assert.equal(await repository.getTripById('trip-session') !== null, true);
  assert.equal(consumeTripPersistenceNotice(), TRIP_SESSION_ONLY_NOTICE);
  assert.equal(storage.values.size, 0);
});

test('repository clones returned trips and places', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const trip = sampleTrip('trip-clone', '青岛', '2026-09-16T00:00:00.000Z');
  await repository.saveGeneratedTrip({ trip, places: [samplePlace()] });
  const loaded = await repository.getTripById('trip-clone');
  loaded!.title = 'mutated';
  loaded!.days[0].places[0].placeName = 'mutated';
  const places = await repository.getPlacesForTrip('trip-clone');
  places[0].name = 'mutated';
  assert.equal((await repository.getTripById('trip-clone'))?.title, '青岛 · 1天');
  assert.equal((await repository.getPlacesForTrip('trip-clone'))[0].name, '故宫');
});

test('apply and undo persist through local storage', async () => {
  resetNotice();
  const storage = new MemoryStorage();
  const repository = new LocalStorageTripRepository(new MockTripRepository(), storage);
  const previous = {
    trip: structuredClone(mockShanghaiTrip),
    places: shanghaiPlaces(),
  };
  await repository.saveGeneratedTrip(previous);
  const appliedTrip = structuredClone(mockShanghaiTrip);
  appliedTrip.updatedAt = '2026-09-16T18:00:00.000Z';
  appliedTrip.days[1].places[1].placeName = '豫园';
  await persistAppliedTripChange(repository, {
    currentTripId: mockShanghaiTrip.id,
    trip: appliedTrip,
    places: previous.places,
  });
  const afterApply = new LocalStorageTripRepository(new MockTripRepository(), storage);
  assert.equal((await afterApply.getTripById(mockShanghaiTrip.id))?.days[1].places[1].placeName, '豫园');

  await restoreTripChangeSnapshot(afterApply, previous, mockShanghaiTrip.id);
  const afterUndo = new LocalStorageTripRepository(new MockTripRepository(), storage);
  assert.equal((await afterUndo.getTripById(mockShanghaiTrip.id))?.days[1].places[1].placeName, '武康路');
  const places = await afterUndo.getPlacesForTrip(mockShanghaiTrip.id);
  assert.deepEqual(places.map((place) => place.id), referencedPlaceIdsInTripOrder(mockShanghaiTrip));
});

test('homepage recent trips and workspace pages stay within the persistence boundary', () => {
  const home = readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');
  const recent = readFileSync(join(process.cwd(), 'src/components/home/RecentTripsSection.tsx'), 'utf8');
  const detail = readFileSync(join(process.cwd(), 'src/pages/TripDetailPage.tsx'), 'utf8');
  const plan = readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8');
  const change = readFileSync(join(process.cwd(), 'src/services/trip-change-service.ts'), 'utf8');

  assert.match(home, /RecentTripsSection/);
  assert.match(home, /selectRecentTrips/);
  assert.match(home, /deleteTrip/);
  assert.equal(home.includes('TripSection'), false);
  assert.equal(home.includes('继续规划'), false);
  assert.equal(home.includes('Mock'), false);
  assert.equal(home.includes('BFF'), false);

  assert.match(recent, /最近行程/);
  assert.match(recent, /window\.confirm/);
  assert.match(recent, /\/trips\/\$\{trip\.id\}/);
  assert.match(recent, /删除/);
  assert.equal(recent.includes('Mock'), false);
  assert.equal(recent.includes('BFF'), false);

  assert.match(detail, /getPlacesForTrip/);
  assert.match(detail, /persistAppliedTripChange/);
  assert.match(detail, /restoreTripChangeSnapshot/);
  assert.match(detail, /这趟旅行不存在/);
  assert.equal(detail.includes('mockPlaces'), false);

  assert.match(plan, /saveGeneratedTrip/);
  assert.match(change, /saveGeneratedTrip/);
});

test('frontend source does not embed keys, models, prompts or Amap DTOs', () => {
  const forbidden = [
    'DASHSCOPE_API_KEY',
    'AMAP_WEB_SERVICE_KEY',
    'AMAP_JS_KEY',
    'qwen3.7-plus',
    'dashscope.aliyuncs.com',
    'json_schema',
  ];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
  for (const file of walk(join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} contains ${token}`);
    }
  }
});
