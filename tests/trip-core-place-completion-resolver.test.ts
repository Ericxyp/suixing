import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeResolvedTripCorePlaces,
  coreCompletionQueries,
} from '../server/services/trip-core-place-completion-resolver';
import type { PlaceSearchService, ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';
import type { Place } from '../src/domain/trip/types';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '北京市东城区示例路 1 号',
    latitude: 39.91,
    longitude: 116.40,
    category: 'attraction',
    ...overrides,
  };
}

function plan(stops: Place[]): ResolvedTripPlanSuggestion {
  return {
    title: '北京三日',
    summary: '均衡行程。',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '城区经典',
      summary: '故宫一带。',
      stops: stops.map((item, index) => ({
        place: item,
        category: 'sight' as const,
        suggestedStartTime: index === 0 ? '10:00' : '14:30',
        suggestedDurationMinutes: 90,
        reason: '核心地点。',
        sourceQuery: item.name,
      })),
    }],
  };
}

class FakeSearch implements PlaceSearchService {
  calls: string[] = [];

  constructor(private readonly byQuery: (query: string) => Place[]) {}

  async search(input: { query: string }): Promise<Place[]> {
    this.calls.push(input.query);
    return this.byQuery(input.query).map((item) => structuredClone(item));
  }
}

const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.397 });
const temple = place({ id: 'amap:TEMPLE', name: '太庙', latitude: 39.91, longitude: 116.394 });
const mall = place({ id: 'amap:MALL', name: '王府井百货', category: 'shopping', latitude: 39.91, longitude: 116.41 });
const diner = place({ id: 'amap:FOOD', name: '故宫附近餐厅', category: 'restaurant', latitude: 39.912, longitude: 116.398 });
const bus = place({ id: 'amap:BUS', name: '天安门东地铁站', category: 'transport', latitude: 39.908, longitude: 116.398 });
const laterTemple = place({ id: 'amap:TEMPLE', name: '太庙', latitude: 39.91, longitude: 116.394 });
const altPark = place({ id: 'amap:ALT', name: '北海公园', latitude: 39.928, longitude: 116.389 });

test('completes a no-preference balanced day from two ordinary cores', async () => {
  const search = new FakeSearch((query) => {
    if (query.includes('附近') || query.includes('景点') || query.includes('博物馆')) {
      return [mall, diner, bus, temple];
    }
    return [];
  });
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  assert.equal(completed.days[0].stops.length, 3);
  assert.equal(completed.days[0].stops[2].place.id, 'amap:TEMPLE');
  assert.equal(completed.days[0].stops.some((stop) => stop.place.category === 'shopping'), false);
  assert.equal(completed.days[0].stops.some((stop) => stop.place.category === 'restaurant'), false);
  assert.equal(completed.days[0].stops.some((stop) => stop.place.category === 'transport'), false);
});

test('rejects ineligible candidates and can fail to fill a third core', async () => {
  const search = new FakeSearch(() => [mall, diner, bus]);
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  assert.equal(completed.days[0].stops.length, 2);
});

test('candidate order does not change the selected Place.id', async () => {
  const first = new FakeSearch(() => [altPark, laterTemple]);
  const second = new FakeSearch(() => [laterTemple, altPark]);
  const left = await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: first,
  });
  const right = await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: second,
  });
  assert.equal(left.days[0].stops[2].place.id, right.days[0].stops[2].place.id);
});

test('explicit preferences do not fall back to classic city labels', async () => {
  const search = new FakeSearch(() => [temple]);
  await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['博物馆'],
  });
  assert.equal(search.calls.some((query) => query === '北京 公园' || query === '北京 博物馆'), false);
  const preferred = coreCompletionQueries({
    destination: '北京',
    day: { title: '城区经典', dayNumber: 1 },
    cores: plan([palace, park]).days[0].stops,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['博物馆'],
  });
  assert.equal(preferred.some((query) => query.includes('博物馆 景点')), true);
  assert.equal(preferred.some((query) => query === '北京 公园'), false);
});

test('the same query is searched only once per generation', async () => {
  const search = new FakeSearch(() => [temple]);
  await completeResolvedTripCorePlaces({
    plan: {
      title: '北京',
      summary: '',
      unresolved: [],
      days: [
        plan([palace, park]).days[0],
        {
          ...plan([palace, park]).days[0],
          dayNumber: 2,
          title: '城区经典',
        },
      ],
    },
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  const nearby = search.calls.filter((query) => query === '故宫博物院 附近 景点');
  assert.equal(nearby.length, 1);
});
