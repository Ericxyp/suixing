import assert from 'node:assert/strict';
import test from 'node:test';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { MockTripRepository } from '../src/repositories/mock-trip-repository';
import {
  referencedPlaceIdsInTripOrder,
  TripRepositoryError,
} from '../src/repositories/trip-repository';
import { MockAiTripService } from '../src/services/mock-ai-trip-service';

test('Mock AI extracts the Shanghai example into structured requirements', async () => {
  const result = await new MockAiTripService().extractRequirements('国庆去上海 3 天，两个人，预算 4000，喜欢咖啡店和拍照，不想太累。');
  assert.deepEqual(result.draft.preferences?.interests, ['咖啡', '拍照']);
  assert.equal(result.draft.destination, '上海');
  assert.equal(result.draft.durationDays, 3);
  assert.equal(result.draft.travelerCount, 2);
  assert.equal(result.draft.totalBudget, 4000);
  assert.equal(result.draft.pace, 'relaxed');
});

test('Mock AI leaves traveler count unknown for parents input and reports missing destination', async () => {
  const service = new MockAiTripService();
  const hangzhou = await service.extractRequirements('周末去杭州两天，带父母，想看西湖，不想走太多路。');
  assert.equal(hangzhou.draft.destination, '杭州');
  assert.equal(hangzhou.draft.travelerCount, undefined);
  assert.deepEqual(hangzhou.draft.preferences?.mustVisit, ['西湖']);
  assert.equal(hangzhou.draft.pace, 'relaxed');
  const missing = await service.extractRequirements('三天，两个人，预算 4000');
  assert.ok(missing.missingRequiredFields.some((issue) => issue.field === 'destination'));
});

test('createTrip is readable in the repository without mutating existing mocks', async () => {
  const repository = new MockTripRepository();
  const created = await repository.createTrip({
    userId: 'user-demo-001',
    requirements: { destination: '西安', durationDays: 3, travelerCount: 2, totalBudget: 3000, pace: 'balanced', preferences: { interests: ['美食'] } },
  });
  assert.equal(created.status, 'PLANNING');
  assert.deepEqual(created.days, []);
  assert.equal((await repository.getTripById(created.id))?.title, '西安 · 3天');
  assert.ok((await repository.getTripsByUserId('user-demo-001')).some((trip) => trip.id === created.id));
  assert.equal(mockShanghaiTrip.title, '上海 · 3天2晚');
});

test('saveTrip upserts a generated trip without mutating the input', async () => {
  const repository = new MockTripRepository();
  const created = await repository.createTrip({
    userId: 'user-demo-001',
    requirements: { destination: '成都', durationDays: 2, travelerCount: 1, totalBudget: 2000, pace: 'relaxed', preferences: { interests: [] } },
  });
  created.title = 'mutated-before-save';
  const saved = await repository.saveTrip({
    ...created,
    title: '成都精选',
  });
  saved.title = 'mutated-after-save';
  assert.equal((await repository.getTripById(created.id))?.title, '成都精选');
});

test('saveGeneratedTrip atomically stores trip places and rejects missing references', async () => {
  const repository = new MockTripRepository();
  const shanghai = structuredClone(mockShanghaiTrip);
  shanghai.id = 'trip-generated-places';
  const referenced = referencedPlaceIdsInTripOrder(shanghai);
  const places = referenced.map((placeId) => structuredClone(mockPlaces.find((place) => place.id === placeId)!));
  const extra = structuredClone(mockPlaces[0]);
  extra.id = 'place-unreferenced';
  const saved = await repository.saveGeneratedTrip({
    trip: shanghai,
    places: [...places, extra],
  });
  saved.title = 'mutated';
  const storedPlaces = await repository.getPlacesForTrip(shanghai.id);
  storedPlaces[0].name = 'mutated-place';
  const reread = await repository.getPlacesForTrip(shanghai.id);
  assert.equal((await repository.getTripById(shanghai.id))?.title, mockShanghaiTrip.title);
  assert.equal(reread.length, referenced.length);
  assert.equal(reread.some((place) => place.id === 'place-unreferenced'), false);
  assert.equal(reread[0].name, places[0].name);
  assert.deepEqual(reread.map((place) => place.id), referenced);

  const before = await repository.getTripById(shanghai.id);
  await assert.rejects(
    () => repository.saveGeneratedTrip({
      trip: shanghai,
      places: places.slice(1),
    }),
    (error: unknown) => error instanceof TripRepositoryError && error.code === 'INVALID_REQUEST',
  );
  assert.equal((await repository.getTripById(shanghai.id))?.title, before?.title);
  assert.equal((await repository.getPlacesForTrip(shanghai.id)).length, referenced.length);
});

test('shanghai mock trip still exposes catalog places for the map', async () => {
  const repository = new MockTripRepository();
  const places = await repository.getPlacesForTrip(mockShanghaiTrip.id);
  assert.deepEqual(
    places.map((place) => place.id),
    referencedPlaceIdsInTripOrder(mockShanghaiTrip),
  );
  assert.ok(places.every((place) => Number.isFinite(place.latitude)));
  places[0].name = 'mutated';
  assert.equal((await repository.getPlacesForTrip(mockShanghaiTrip.id))[0].name !== 'mutated', true);
});
