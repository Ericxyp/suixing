import assert from 'node:assert/strict';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import { parseMealOptionsBody } from '../server/services/trip-meal-options-request';
import { searchMealDiningPlaces } from '../server/services/trip-meal-options';
import type { PlaceSearchService } from '../server/services/trip-place-resolver';
import type { Place } from '../src/domain/trip/types';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '北京市东城区',
    latitude: 39.916,
    longitude: 116.397,
    category: 'restaurant',
    ...overrides,
  };
}

test('meal options body rejects trip snapshots, keys, urls and extra fields', () => {
  const valid = {
    city: '北京',
    mealPeriod: 'lunch',
    area: { placeId: 'amap:AREA', name: '东四附近', longitude: 116.4, latitude: 39.9 },
  };
  assert.ok(parseMealOptionsBody(valid));
  assert.equal(parseMealOptionsBody({ ...valid, trip: { id: 'x' } }), undefined);
  assert.equal(parseMealOptionsBody({ ...valid, key: 'secret' }), undefined);
  assert.equal(parseMealOptionsBody({ ...valid, prompt: 'x' }), undefined);
  assert.equal(parseMealOptionsBody({ ...valid, extra: true }), undefined);
  assert.equal(parseMealOptionsBody({
    ...valid,
    area: { ...valid.area, latitude: 120 },
  }), undefined);
  assert.equal(parseMealOptionsBody({
    ...valid,
    city: 'https://example.com',
  }), undefined);
});

test('filters non-dining POIs and sorts by area then next place distance and id', async () => {
  const near = place({ id: 'amap:NEAR', name: '近处餐厅', latitude: 39.901, longitude: 116.401 });
  const far = place({ id: 'amap:FAR', name: '远处餐厅', latitude: 40.1, longitude: 116.6 });
  const bus = place({ id: 'amap:BUS', name: '东四公交站', category: 'transport', latitude: 39.9, longitude: 116.4 });
  const mall = place({ id: 'amap:MALL', name: '东四停车场', category: 'transport', latitude: 39.9, longitude: 116.4 });
  const search: PlaceSearchService = {
    async search() {
      return [far, bus, mall, near];
    },
  };
  const result = await searchMealDiningPlaces({
    city: '北京',
    mealPeriod: 'lunch',
    area: { id: 'amap:AREA', name: '东四', latitude: 39.9, longitude: 116.4 },
    nextPlace: { id: 'amap:NEXT', latitude: 39.905, longitude: 116.405 },
    placeSearch: search,
  });
  assert.deepEqual(result.map((item) => item.id), ['amap:NEAR', 'amap:FAR']);
  assert.equal(JSON.stringify(result).includes('评分'), false);
  assert.equal(JSON.stringify(result).includes('网红'), false);
});

test('stable sort uses place id when distances match', async () => {
  const a = place({ id: 'amap:A', name: '甲餐厅', latitude: 39.9, longitude: 116.4 });
  const b = place({ id: 'amap:B', name: '乙餐厅', latitude: 39.9, longitude: 116.4 });
  const searchFirst: PlaceSearchService = { async search() { return [b, a]; } };
  const searchSecond: PlaceSearchService = { async search() { return [a, b]; } };
  const left = await searchMealDiningPlaces({
    city: '北京',
    mealPeriod: 'lunch',
    area: { id: 'amap:AREA', name: '东四', latitude: 39.9, longitude: 116.4 },
    placeSearch: searchFirst,
  });
  const right = await searchMealDiningPlaces({
    city: '北京',
    mealPeriod: 'lunch',
    area: { id: 'amap:AREA', name: '东四', latitude: 39.9, longitude: 116.4 },
    placeSearch: searchSecond,
  });
  assert.deepEqual(left.map((item) => item.id), right.map((item) => item.id));
  assert.deepEqual(left.map((item) => item.id), ['amap:A', 'amap:B']);
});

test('returns an empty list without inventing restaurants', async () => {
  const search: PlaceSearchService = { async search() { return []; } };
  const result = await searchMealDiningPlaces({
    city: '北京',
    mealPeriod: 'lunch',
    area: { id: 'amap:AREA', name: '东四', latitude: 39.9, longitude: 116.4 },
    placeSearch: search,
  });
  assert.deepEqual(result, []);
});

test('provider errors surface as Amap failures', async () => {
  const search: PlaceSearchService = {
    async search() {
      throw new AmapProviderError('PROVIDER_ERROR', 'upstream');
    },
  };
  await assert.rejects(
    () => searchMealDiningPlaces({
      city: '北京',
      mealPeriod: 'lunch',
      area: { id: 'amap:AREA', name: '东四', latitude: 39.9, longitude: 116.4 },
      placeSearch: search,
    }),
    (error: unknown) => error instanceof AmapProviderError,
  );
});
