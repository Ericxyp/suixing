import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  enumerateCoreCompletionCombinationsV1,
  runCoreCombinationSnapshotShadowV1,
  scoreDayCoreCombinationSnapshotV1,
  scorePreRouteCoreCombinationV1,
  snapshotCoreCompletionCandidatesV1,
} from '../server/services/trip-core-combination-snapshot-v1';
import { evaluateDayCombinationV1 } from '../server/services/trip-day-combination-evaluator-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { Place } from '../src/domain/trip/types';
import type { PlaceSearchService, ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';
import {
  CORE_COMBINATION_SNAPSHOT_LIMIT_V1,
  CORE_COMBINATION_SNAPSHOT_MAX_SLOTS_V1,
} from '../src/domain/trip/core-combination-snapshot-v1';

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

const museum = place({ id: 'amap:NAT', name: '国家博物馆' });
const otherMuseum = place({ id: 'amap:CAP', name: '首都博物馆', latitude: 39.905, longitude: 116.361 });
const thirdMuseum = place({ id: 'amap:MIL', name: '军事博物馆', latitude: 39.907, longitude: 116.322 });
const park = place({ id: 'amap:PARK', name: '北海公园', latitude: 39.928, longitude: 116.389 });
const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const extra = place({ id: 'amap:TOWER', name: '永定门城楼', latitude: 39.871, longitude: 116.393 });
const hotel = place({ id: 'amap:HOTEL', name: '如家酒店', category: 'hotel' });
const cafe = place({ id: 'amap:CAFE', name: '咖啡店', category: 'cafe' });
const far = place({ id: 'amap:FAR', name: '颐和园', latitude: 39.999, longitude: 116.275 });

function stop(item: Place, minutes = 90) {
  return {
    place: item,
    category: 'sight' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: minutes,
    reason: '核心地点。',
    sourceQuery: item.name,
  };
}

function slot(dayNumber: number, slotIndex: number, candidates: Place[]) {
  return {
    dayNumber,
    slotIndex,
    candidates: snapshotCoreCompletionCandidatesV1(candidates),
  };
}

test('a single completion slot keeps at most 3 candidates and the original first pick', async () => {
  const ranked = [otherMuseum, park, extra, thirdMuseum];
  const snapshots = snapshotCoreCompletionCandidatesV1(ranked);
  assert.equal(snapshots.length, CORE_COMBINATION_SNAPSHOT_LIMIT_V1);
  assert.deepEqual(snapshots.map((item) => item.place.id), [otherMuseum.id, park.id, extra.id]);
  const combinations = enumerateCoreCompletionCombinationsV1([slot(1, 0, ranked)]);
  assert.equal(combinations.length, 3);
  const closeMuseum = place({ id: 'amap:CAP', name: '首都博物馆' });
  let calls = 0;
  const search = {
    async search() {
      calls += 1;
      return [closeMuseum, park, extra, thirdMuseum].map((item) => structuredClone(item));
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
      stops: [stop(museum), stop(palace)],
    }],
  };
  const completed = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  assert.equal(completed.days[0].stops[2]?.place.id, closeMuseum.id);
  assert.ok(calls >= 1);
});

test('two slots enumerate at most 9 combinations and drop duplicate ids', () => {
  const slots = [
    slot(1, 0, [museum, park, extra]),
    slot(1, 1, [museum, park, extra]),
  ];
  const combinations = enumerateCoreCompletionCombinationsV1(slots);
  assert.ok(combinations.length <= 3 * 3);
  assert.ok(CORE_COMBINATION_SNAPSHOT_MAX_SLOTS_V1 === 2);
  assert.equal(combinations.some((item) => item.placeIds[0] === item.placeIds[1]), false);
  assert.equal(combinations.length, 6);
});

test('non-core, far and duplicate candidates never enter the snapshot', () => {
  const snapshots = snapshotCoreCompletionCandidatesV1(
    [hotel, cafe, far, museum, park],
    [hotel, cafe, far, museum, park],
  );
  assert.equal(snapshots.some((item) => ['hotel', 'cafe', 'shopping', 'transport'].includes(item.place.category)), false);
  const search: PlaceSearchService = {
    async search() {
      return [hotel, cafe, far, museum].map((item) => structuredClone(item));
    },
  };
  return completeResolvedTripCorePlaces({
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
    pace: 'relaxed',
    policy: {
      targetCorePlacesPerDay: 2,
      maxCoreAreaDistanceMeters: 12_000,
      preferredInterestKeys: [],
      excludedInterestKeys: [],
      preferClassicLandmarks: true,
      preferIndoor: false,
      preferOutdoor: false,
    },
    placeSearch: search,
  }).then((completed) => {
    assert.equal(completed.days[0].stops.some((item) => item.place.category === 'hotel'), false);
    assert.equal(completed.days[0].stops.some((item) => item.place.id === far.id), false);
    assert.equal(completed.days[0].stops.some((item) => item.place.id === museum.id), true);
  });
});

test('fewer than 3 candidates enumerate without extra searches', async () => {
  let calls = 0;
  const search: PlaceSearchService = {
    async search() {
      calls += 1;
      return [structuredClone(park), structuredClone(extra)];
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
  const combinations = enumerateCoreCompletionCombinationsV1([slot(1, 0, [park, extra])]);
  assert.equal(combinations.length, 2);
  assert.equal(calls, 1);
  assert.ok(completed.days[0].stops.length >= 2);
});

test('pre-route scoring keeps route efficiency at the neutral 50', () => {
  const score = scorePreRouteCoreCombinationV1({
    dayNumber: 1,
    originalCores: [stop(palace)],
    comboPlaces: [park],
    policy: { targetCorePlacesPerDay: 2 },
  });
  const combination = evaluateDayCombinationV1({
    day: {
      id: 'shadow-day-1',
      tripId: 'shadow',
      dayNumber: 1,
      date: '1970-01-01',
      places: [
        {
          id: 'shadow:amap:PALACE',
          dayId: 'shadow-day-1',
          order: 1,
          placeId: palace.id,
          placeName: palace.name,
          type: palace.category,
          durationMinutes: 90,
          estimatedCost: 0,
        },
        {
          id: 'shadow:amap:PARK',
          dayId: 'shadow-day-1',
          order: 2,
          placeId: park.id,
          placeName: park.name,
          type: park.category,
          durationMinutes: 90,
          estimatedCost: 0,
        },
      ],
    },
    places: [palace, park],
    routes: [],
    policy: { targetCorePlacesPerDay: 2 },
  });
  assert.equal(combination.breakdown.routeEfficiency, 50);
  assert.equal(typeof score, 'number');
});

test('identical snapshot inputs stay deterministic', () => {
  const slots = [slot(2, 0, [otherMuseum, park, extra]), slot(2, 1, [thirdMuseum, extra, park])];
  const input = {
    dayNumber: 2,
    slots,
    originalCores: [stop(palace)],
    policy: { targetCorePlacesPerDay: 3 as const },
  };
  assert.deepEqual(scoreDayCoreCombinationSnapshotV1(input), scoreDayCoreCombinationSnapshotV1(structuredClone(input)));
  assert.deepEqual(
    snapshotCoreCompletionCandidatesV1([otherMuseum, park, extra]),
    snapshotCoreCompletionCandidatesV1([otherMuseum, park, extra]),
  );
});

test('a higher shadow combination score does not replace ranked[0]', async () => {
  const closeMuseum = place({ id: 'amap:CAP', name: '首都博物馆' });
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(closeMuseum), structuredClone(park), structuredClone(extra)];
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
        stops: [stop(museum), stop(thirdMuseum)],
      }],
    },
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
  });
  const snapshot = scoreDayCoreCombinationSnapshotV1({
    dayNumber: 1,
    slots: [slot(1, 0, [closeMuseum, park, extra])],
    originalCores: [stop(museum), stop(thirdMuseum)],
    policy: { targetCorePlacesPerDay: 3 },
  });
  const best = [...snapshot.combinations].sort((left, right) => right.preRouteScore - left.preRouteScore)[0];
  const actual = completed.days[0].stops[2]?.place.id;
  assert.equal(actual, closeMuseum.id);
  assert.equal(best?.placeIds[0], park.id);
  assert.notEqual(actual, best?.placeIds[0]);
});

test('snapshot and combination errors do not change generation', async () => {
  let calls = 0;
  const search = {
    async search() {
      calls += 1;
      return [structuredClone(park)];
    },
  };
  assert.doesNotThrow(() => {
    runCoreCombinationSnapshotShadowV1(() => {
      throw new Error('snapshot failed');
    });
  });
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
  assert.equal(calls, 1);
  assert.equal(completed.days[0].stops.some((item) => item.place.id === park.id), true);
});

test('snapshot types stay off trip API and display surfaces', () => {
  const roots = [
    readFileSync(join(process.cwd(), 'src/services/trip-display.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/services/bff-trip-generation-service.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'server/routes/trip-generate.ts'), 'utf8'),
  ].join('\n');
  assert.equal(roots.includes('DayCoreCombinationSnapshotV1'), false);
  assert.equal(roots.includes('scoreDayCoreCombinationSnapshotV1'), false);
});
