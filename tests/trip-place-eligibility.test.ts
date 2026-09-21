import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedPlaceCategoriesForSuggestion,
  evaluateTripPlaceEligibility,
  filterEligibleTripPlaces,
} from '../server/services/trip-place-eligibility';
import type { TripPlanPlaceCategory } from '../server/services/trip-plan-generator';
import type { Place } from '../src/domain/trip/types';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '扬州市邗江区示例路 1 号',
    latitude: 32.4,
    longitude: 119.4,
    category: 'attraction',
    ...overrides,
  };
}

function suggestion(
  name: string,
  category: TripPlanPlaceCategory = 'sight',
  query = name,
) {
  return {
    name,
    query,
    category,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
  };
}

test('rejects transit and service names even when category is attraction', () => {
  const bus = place({ id: 'amap:BUS', name: '大明寺(公交站)' });
  const decision = evaluateTripPlaceEligibility(bus, suggestion('大明寺'));
  assert.equal(decision.eligible, false);
  assert.equal(decision.kind, 'INELIGIBLE');
  assert.equal(decision.reason, 'TRANSIT_OR_SERVICE');
});

test('allows a dock only when the query names 码头', () => {
  const dock = place({ id: 'amap:DOCK', name: '瘦西湖码头' });
  assert.equal(evaluateTripPlaceEligibility(dock, suggestion('瘦西湖')).eligible, false);
  assert.equal(evaluateTripPlaceEligibility(dock, suggestion('瘦西湖码头')).eligible, true);
});

test('maps suggestion categories onto existing Place.category values', () => {
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('food')], ['restaurant']);
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('coffee')], ['cafe']);
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('shopping')], ['shopping']);
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('hotel')], []);
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('sight')].sort(), ['activity', 'attraction']);
  assert.deepEqual([...allowedPlaceCategoriesForSuggestion('other')].sort(), ['activity', 'attraction']);
});

test('hotel places and hotel suggestions are never eligible for new writes', () => {
  const inn = place({ id: 'amap:HOTEL', name: '如家酒店', category: 'hotel' });
  assert.equal(evaluateTripPlaceEligibility(inn, suggestion('如家酒店', 'hotel')).eligible, false);
  assert.equal(evaluateTripPlaceEligibility(inn, suggestion('故宫博物院')).eligible, false);
  assert.equal(evaluateTripPlaceEligibility(inn, suggestion('如家酒店', 'hotel')).reason, 'CATEGORY_MISMATCH');
  assert.deepEqual(filterEligibleTripPlaces([inn], suggestion('如家酒店', 'hotel')), []);
});

test('sight intent rejects restaurants and cafes', () => {
  const tea = place({ id: 'amap:TEA', name: '个园茶社', category: 'restaurant' });
  const cafe = place({ id: 'amap:CAFE', name: '个园咖啡', category: 'cafe' });
  assert.equal(evaluateTripPlaceEligibility(tea, suggestion('个园')).reason, 'CATEGORY_MISMATCH');
  assert.equal(evaluateTripPlaceEligibility(cafe, suggestion('扬州博物馆', 'other')).reason, 'CATEGORY_MISMATCH');
  const dining = place({ id: 'amap:FOOD', name: '冶春园', category: 'restaurant' });
  assert.equal(evaluateTripPlaceEligibility(dining, suggestion('冶春园茶社', 'food')).eligible, true);
  assert.equal(evaluateTripPlaceEligibility(dining, suggestion('冶春园茶社', 'food')).kind, 'DINING');
});

test('filterEligibleTripPlaces does not mutate the input array', () => {
  const bus = place({ id: 'amap:BUS', name: '大明寺(公交站)', category: 'transport' });
  const temple = place({ id: 'amap:TEMPLE', name: '大明寺' });
  const input = [bus, temple];
  const snapshot = structuredClone(input);
  Object.freeze(input);
  Object.freeze(bus);
  Object.freeze(temple);
  const query = suggestion('大明寺');
  Object.freeze(query);
  const eligible = filterEligibleTripPlaces(input, query);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(eligible.map((item) => item.id), ['amap:TEMPLE']);
});
