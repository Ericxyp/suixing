import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectCanaryCoreCompletionCandidateV1,
  type CanaryCoreCompletionCandidateV1,
} from '../server/services/trip-core-combination-snapshot-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { Place } from '../src/domain/trip/types';
import type { PlaceSearchService, ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';
import {
  CANARY_CORE_COMPLETION_MAX_DISTANCE_METERS_V1,
  CANARY_CORE_COMPLETION_SCORE_GAP_V1,
} from '../src/domain/trip/core-combination-snapshot-v1';
import { haversineMeters } from '../server/services/trip-route-enricher';

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

function offsetNorth(from: Place, meters: number, id: string, name: string): Place {
  let latitude = from.latitude;
  const probe = { latitude: from.latitude, longitude: from.longitude };
  while (haversineMeters(from, { ...probe, latitude }) < meters) {
    latitude += 0.00001;
  }
  return place({ ...from, id, name, latitude });
}

const baselinePlace = place({ id: 'amap:BASE', name: '国家博物馆' });
const nearPlace = offsetNorth(baselinePlace, 800, 'amap:NEAR', '景山公园');
const farPlace = offsetNorth(baselinePlace, 1001, 'amap:FAR', '北海公园');
const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const museum = place({ id: 'amap:NAT', name: '首都博物馆', latitude: 39.905, longitude: 116.361 });
const park = place({ id: 'amap:PARK', name: '北海公园', latitude: 39.928, longitude: 116.389 });

function candidate(
  item: Place,
  score: number,
  overrides: Partial<CanaryCoreCompletionCandidateV1> = {},
): CanaryCoreCompletionCandidateV1 {
  return {
    place: item,
    preRouteScore: score,
    suggestedStartTime: '15:30',
    suggestedDurationMinutes: 90,
    rerankIndex: 1,
    ...overrides,
  };
}

const baseline = candidate(baselinePlace, 50, { rerankIndex: 0 });
const scoringContext = { tripIntent: { interestKeys: ['history' as const] } };

function stop(item: Place) {
  return {
    place: item,
    category: 'sight' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '核心地点。',
    sourceQuery: item.name,
  };
}

test('without scoringContext the canary selector always returns baseline', () => {
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 80)],
    missingCoreCount: 1,
  });
  assert.equal(selected.id, baselinePlace.id);
});

test('two missing cores never enable canary', () => {
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 80)],
    missingCoreCount: 2,
    scoringContext,
  });
  assert.equal(selected.id, baselinePlace.id);
});

test('a 20-point nearby alternative with the same schedule replaces baseline', () => {
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 70)],
    missingCoreCount: 1,
    scoringContext,
  });
  assert.ok(70 - 50 >= CANARY_CORE_COMPLETION_SCORE_GAP_V1);
  assert.ok(haversineMeters(baselinePlace, nearPlace) <= CANARY_CORE_COMPLETION_MAX_DISTANCE_METERS_V1);
  assert.equal(selected.id, nearPlace.id);
});

test('a 14-point gap keeps baseline', () => {
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 64)],
    missingCoreCount: 1,
    scoringContext,
  });
  assert.ok(64 - 50 < CANARY_CORE_COMPLETION_SCORE_GAP_V1);
  assert.equal(selected.id, baselinePlace.id);
});

test('a 1001m alternative keeps baseline', () => {
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(farPlace, 80)],
    missingCoreCount: 1,
    scoringContext,
  });
  assert.ok(haversineMeters(baselinePlace, farPlace) > CANARY_CORE_COMPLETION_MAX_DISTANCE_METERS_V1);
  assert.equal(selected.id, baselinePlace.id);
});

test('different duration or start time keeps baseline', () => {
  const duration = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 80, { suggestedDurationMinutes: 120 })],
    missingCoreCount: 1,
    scoringContext,
  });
  const start = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 80, { suggestedStartTime: '16:00' })],
    missingCoreCount: 1,
    scoringContext,
  });
  assert.equal(duration.id, baselinePlace.id);
  assert.equal(start.id, baselinePlace.id);
});

test('non-core categories cannot win even with a high score', () => {
  for (const category of ['restaurant', 'cafe', 'shopping', 'hotel', 'transport'] as const) {
    const selected = selectCanaryCoreCompletionCandidateV1({
      baseline,
      alternatives: [candidate(place({ id: `amap:${category}`, name: category, category, latitude: nearPlace.latitude }), 90)],
      missingCoreCount: 1,
      scoringContext,
    });
    assert.equal(selected.id, baselinePlace.id);
  }
});

test('tied canary scores keep the rerank index order', () => {
  const later = candidate(nearPlace, 80, { rerankIndex: 2 });
  const earlier = candidate(place({
    id: 'amap:EARLY',
    name: '中山公园',
    latitude: nearPlace.latitude,
  }), 80, { rerankIndex: 1 });
  const selected = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [later, earlier],
    missingCoreCount: 1,
    scoringContext,
  });
  assert.equal(selected.id, earlier.place.id);
});

test('canary errors, NaN scores and missing coordinates fall back to baseline', () => {
  const nan = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, Number.NaN)],
    missingCoreCount: 1,
    scoringContext,
  });
  const missingScore = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(nearPlace, 80, { preRouteScore: Number.POSITIVE_INFINITY })],
    missingCoreCount: 1,
    scoringContext,
  });
  const badCoords = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: [candidate(place({ id: 'amap:BAD', name: '无效点', latitude: Number.NaN }), 80)],
    missingCoreCount: 1,
    scoringContext,
  });
  const thrown = selectCanaryCoreCompletionCandidateV1({
    baseline,
    alternatives: new Proxy([] as CanaryCoreCompletionCandidateV1[], {
      get() {
        throw new Error('canary failed');
      },
    }),
    missingCoreCount: 1,
    scoringContext,
  });
  assert.equal(nan.id, baselinePlace.id);
  assert.equal(missingScore.id, baselinePlace.id);
  assert.equal(badCoords.id, baselinePlace.id);
  assert.equal(thrown.id, baselinePlace.id);
});

test('core completion without scoringContext still uses ranked[0]', async () => {
  const closeMuseum = place({ id: 'amap:NAT', name: '首都博物馆' });
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(closeMuseum), structuredClone(park)];
    },
  };
  const plan: ResolvedTripPlanSuggestion = {
    title: '北京',
    summary: '',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '城区',
      summary: '',
      stops: [stop(palace)],
    }],
  };
  const without = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'relaxed',
    policy: {
      targetCorePlacesPerDay: 2,
      maxCoreAreaDistanceMeters: 25_000,
      preferredInterestKeys: [],
      excludedInterestKeys: [],
      preferClassicLandmarks: true,
      preferIndoor: false,
      preferOutdoor: false,
    },
    placeSearch: search,
  });
  const withScore = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'relaxed',
    policy: {
      targetCorePlacesPerDay: 2,
      maxCoreAreaDistanceMeters: 25_000,
      preferredInterestKeys: [],
      excludedInterestKeys: [],
      preferClassicLandmarks: true,
      preferIndoor: false,
      preferOutdoor: false,
    },
    placeSearch: {
      async search() {
        return [structuredClone(museum), structuredClone(park)];
      },
    },
    scoringContext: {},
  });
  assert.equal(without.days[0].stops[1]?.place.id, closeMuseum.id);
  assert.ok(withScore.days[0].stops[1]?.place.id);
});

test('two missing cores keep both original ranked[0] picks', async () => {
  const first = place({ id: 'amap:A', name: '地点甲' });
  const second = place({ id: 'amap:B', name: '地点乙', latitude: 39.916, longitude: 116.397 });
  let calls = 0;
  const search: PlaceSearchService = {
    async search() {
      calls += 1;
      return calls === 1
        ? [structuredClone(first)]
        : [structuredClone(second)];
    },
  };
  const completed = await completeResolvedTripCorePlaces({
    plan: {
      title: '北京',
      summary: '',
      unresolved: [],
      days: [{
        dayNumber: 1,
        title: '城区',
        summary: '',
        stops: [stop(palace)],
      }],
    },
    destination: '北京',
    pace: 'balanced',
    policy: {
      targetCorePlacesPerDay: 3,
      maxCoreAreaDistanceMeters: 25_000,
      preferredInterestKeys: [],
      excludedInterestKeys: [],
      preferClassicLandmarks: true,
      preferIndoor: false,
      preferOutdoor: false,
    },
    placeSearch: search,
    scoringContext,
  });
  assert.equal(completed.days[0].stops[1]?.place.id, first.id);
  assert.equal(completed.days[0].stops[2]?.place.id, second.id);
});
