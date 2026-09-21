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
const inn = place({ id: 'amap:HOTEL', name: '如家酒店', category: 'hotel', latitude: 39.914, longitude: 116.399 });
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

test('core completion never selects a hotel candidate', async () => {
  const search = new FakeSearch((query) => {
    if (query.includes('附近') || query.includes('景点') || query.includes('博物馆')) {
      return [inn, mall, diner, temple];
    }
    return [inn];
  });
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([palace, park]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  assert.equal(completed.days[0].stops.some((stop) => stop.place.category === 'hotel'), false);
  assert.equal(completed.days[0].stops[2].place.id, 'amap:TEMPLE');
});

test('rejects ineligible candidates and can fail to fill a third core', async () => {
  const search = new FakeSearch(() => [mall, diner, bus, inn]);
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

test('style preferences do not become coffee or photo sight queries', () => {
  const queries = coreCompletionQueries({
    destination: '北京',
    day: { title: '皇城根下的红墙与光影', dayNumber: 1 },
    cores: plan([palace]).days[0].stops,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['咖啡', '拍照', '历史文化', 'coffee', 'photography', 'history'],
  });
  assert.equal(queries.some((query) => /咖啡景点|拍照景点|摄影景点/.test(query.replace(/\s+/g, ''))), false);
  assert.equal(queries.includes('北京 咖啡 景点'), false);
  assert.equal(queries.includes('北京 拍照 景点'), false);
  assert.equal(queries.includes('北京 历史文化 景点'), true);
  assert.equal(queries.includes('北京 博物馆'), true);
  assert.equal(queries.includes('北京 公园'), true);
  assert.equal(queries.includes('北京 历史街区'), true);
});

test('explicit core preference terms stay searchable without classic-only labels first', () => {
  const preferred = coreCompletionQueries({
    destination: '北京',
    day: { title: '城区经典', dayNumber: 1 },
    cores: plan([palace, park]).days[0].stops,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['博物馆'],
  });
  assert.equal(preferred.some((query) => query.includes('博物馆 景点')), true);
  assert.equal(preferred.includes('北京景点'), false);
});

test('a cafe plus one attraction still completes with history fallbacks not coffee queries', async () => {
  const cafe = place({ id: 'amap:CAFE', name: '三里屯咖啡', category: 'cafe', latitude: 39.933, longitude: 116.447 });
  const search = new FakeSearch((query) => {
    if (query.includes('咖啡') || query.includes('拍照')) {
      return [cafe];
    }
    return [temple];
  });
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([palace, cafe]),
    destination: '北京',
    pace: 'balanced',
    policy: { targetCorePlacesPerDay: 2, maxCoreAreaDistanceMeters: 12_000, preferredInterestKeys: ['coffee', 'photography', 'history'], excludedInterestKeys: [], preferClassicLandmarks: true, preferIndoor: false, preferOutdoor: false },
    placeSearch: search,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['咖啡', '拍照', '历史文化', 'coffee', 'photography', 'history'],
  });
  const cores = completed.days[0].stops.filter((stop) => (
    stop.place.category === 'attraction' || stop.place.category === 'activity'
  ));
  assert.ok(cores.length >= 2);
  assert.equal(search.calls.some((query) => query.includes('咖啡 景点') || query.includes('拍照 景点')), false);
  const plannedQueries = coreCompletionQueries({
    destination: '北京',
    day: { title: '城区经典', dayNumber: 1 },
    cores: plan([palace]).days[0].stops,
    hasExplicitTravelPreferences: true,
    preferenceTerms: ['咖啡', '拍照', '历史文化', 'coffee', 'photography', 'history'],
  });
  assert.equal(plannedQueries.includes('北京 历史文化 景点'), true);
  assert.equal(plannedQueries.includes('北京 博物馆'), true);
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
