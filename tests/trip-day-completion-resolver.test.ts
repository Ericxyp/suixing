import assert from 'node:assert/strict';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import { completeEnrichedTripPlan } from '../server/services/trip-day-completion-resolver';
import type { PlaceSearchService } from '../server/services/trip-place-resolver';
import type {
  RouteEnrichedTripPlanSuggestion,
  TripRouteEnricher,
} from '../server/services/trip-route-enricher';
import type { Place } from '../src/domain/trip/types';

function geoPlace(id: string, name: string, latitude: number, longitude: number, category: Place['category'] = 'attraction'): Place {
  return {
    id,
    provider: 'amap',
    providerPlaceId: id,
    name,
    address: '北京市东城区',
    latitude,
    longitude,
    category,
  };
}

function plan(): RouteEnrichedTripPlanSuggestion {
  const first = geoPlace('amap:TEMPLE', '天坛公园', 39.882, 116.407);
  const second = geoPlace('amap:SUMMER', '颐和园', 39.999, 116.275);
  return {
    title: '北京',
    summary: '两站',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '第一天',
      summary: '城区',
      stops: [
        {
          place: first,
          category: 'sight',
          suggestedStartTime: '10:00',
          suggestedDurationMinutes: 90,
          reason: '上午游览。',
          sourceQuery: '天坛',
        },
        {
          place: second,
          category: 'sight',
          suggestedStartTime: '14:30',
          suggestedDurationMinutes: 90,
          reason: '下午游览。',
          sourceQuery: '颐和园',
        },
      ],
      routes: [{
        fromPlaceId: first.id,
        toPlaceId: second.id,
        transport: { mode: 'taxi', durationMinutes: 25, distanceMeters: 8000 },
        polyline: [
          { latitude: first.latitude, longitude: first.longitude },
          { latitude: second.latitude, longitude: second.longitude },
        ],
      }],
      unresolvedRoutes: [],
    }],
  };
}

function enricher(): TripRouteEnricher {
  return {
    async enrich({ plan }) {
      return {
        ...plan,
        days: plan.days.map((day) => ({
          ...day,
          routes: day.stops.slice(0, -1).map((stop, index) => ({
            fromPlaceId: stop.place.id,
            toPlaceId: day.stops[index + 1].place.id,
            transport: { mode: 'taxi' as const, durationMinutes: 20, distanceMeters: 4000 },
            polyline: [
              { latitude: stop.place.latitude, longitude: stop.place.longitude },
              { latitude: day.stops[index + 1].place.latitude, longitude: day.stops[index + 1].place.longitude },
            ],
          })),
          unresolvedRoutes: [],
        })),
      };
    },
  };
}

test('inserts nearby lunch and dinner restaurants instead of generic experiences', async () => {
  const near = geoPlace('amap:NEAR', '近处餐厅', 39.883, 116.408, 'restaurant');
  const far = geoPlace('amap:FAR', '远处餐厅', 40.1, 116.6, 'restaurant');
  const dinner = geoPlace('amap:DINNER', '晚饭馆', 40.0, 116.27, 'restaurant');
  const queries: string[] = [];
  const search: PlaceSearchService = {
    async search(input) {
      queries.push(input.query);
      if (input.query.includes('晚餐')) {
        return [dinner];
      }
      return [far, near];
    },
  };
  const completed = await completeEnrichedTripPlan({
    plan: plan(),
    destination: '北京',
    pace: 'balanced',
    diningMode: 'arranged',
    placeSearch: search,
    routeEnricher: enricher(),
  });
  const names = completed.days[0].stops.map((stop) => stop.place.name);
  assert.equal(names.includes('近处餐厅'), true);
  assert.equal(names.includes('远处餐厅'), false);
  assert.equal(names[0], '天坛公园');
  assert.equal(names[1], '近处餐厅');
  assert.equal(JSON.stringify(completed).includes('自由活动'), false);
  assert.ok(queries.some((query) => query.includes('餐厅')));
  assert.ok(queries.length <= 4);
  const starts = completed.days[0].stops.map((stop) => stop.suggestedStartTime);
  for (let index = 0; index < starts.length - 1; index += 1) {
    assert.ok(starts[index] < starts[index + 1]);
  }
});

test('candidate order does not change the nearest restaurant', async () => {
  const near = geoPlace('amap:NEAR', '近处餐厅', 39.883, 116.408, 'restaurant');
  const far = geoPlace('amap:FAR', '远处餐厅', 40.1, 116.6, 'restaurant');
  const searchA: PlaceSearchService = { async search() { return [far, near]; } };
  const searchB: PlaceSearchService = { async search() { return [near, far]; } };
  const left = await completeEnrichedTripPlan({
    plan: plan(),
    destination: '北京',
    pace: 'balanced',
    diningMode: 'arranged',
    placeSearch: searchA,
    routeEnricher: enricher(),
  });
  const right = await completeEnrichedTripPlan({
    plan: plan(),
    destination: '北京',
    pace: 'balanced',
    diningMode: 'arranged',
    placeSearch: searchB,
    routeEnricher: enricher(),
  });
  assert.equal(left.days[0].stops[1].place.id, right.days[0].stops[1].place.id);
});

test('rejects transport substitutes and does not invent restaurants', async () => {
  const bus = geoPlace('amap:BUS', '天坛公交站', 39.882, 116.407, 'transport');
  const search: PlaceSearchService = {
    async search() {
      return [bus];
    },
  };
  const completed = await completeEnrichedTripPlan({
    plan: plan(),
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
    routeEnricher: enricher(),
  });
  assert.equal(completed.days[0].stops.every((stop) => stop.place.category !== 'restaurant'), true);
});

test('place search provider errors stay as Amap failures', async () => {
  const search: PlaceSearchService = {
    async search() {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi timeout');
    },
  };
  await assert.rejects(
    () => completeEnrichedTripPlan({
      plan: plan(),
      destination: '北京',
      pace: 'balanced',
      diningMode: 'arranged',
      placeSearch: search,
      routeEnricher: enricher(),
    }),
    (error: unknown) => error instanceof AmapProviderError && error.code === 'PROVIDER_ERROR',
  );
});

test('does not replace existing core attractions when adding meals', async () => {
  const lunch = geoPlace('amap:LUNCH', '午餐店', 39.883, 116.408, 'restaurant');
  const search: PlaceSearchService = {
    async search() {
      return [lunch];
    },
  };
  const completed = await completeEnrichedTripPlan({
    plan: plan(),
    destination: '北京',
    pace: 'balanced',
    diningMode: 'arranged',
    placeSearch: search,
    routeEnricher: enricher(),
  });
  const cores = completed.days[0].stops.filter((stop) => stop.place.category === 'attraction').map((stop) => stop.place.id);
  assert.deepEqual(cores, ['amap:TEMPLE', 'amap:SUMMER']);
});
