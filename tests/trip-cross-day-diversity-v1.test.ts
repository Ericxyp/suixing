import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCrossDayDiversityPenaltyV1 } from '../server/services/trip-cross-day-diversity-v1';
import {
  CORE_CANDIDATE_SCORE_GAP_V1,
  rerankCoreCompletionCandidatesV1,
} from '../server/services/trip-core-candidate-ranking-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { CandidateEvaluationV1 } from '../src/domain/trip/recommendation-scoring-v1';
import type { Place } from '../src/domain/trip/types';
import type { ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';
import {
  CROSS_DAY_DIVERSITY_PENALTY_MANY_DAYS,
  CROSS_DAY_DIVERSITY_PENALTY_ONE_DAY,
} from '../src/domain/trip/cross-day-diversity-v1';

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
const unnamed = place({ id: 'amap:X', name: '示例地点甲' });

function eligible(total: number): CandidateEvaluationV1 {
  return {
    constraints: { eligible: true, reasons: [] },
    score: {
      total,
      breakdown: {
        preferenceMatch: total,
        tripIntentMatch: total,
        partyFit: 50,
        routeFit: 50,
        dataConfidence: 100,
      },
    },
  };
}

function previous(dayNumber: number, item: Place) {
  return { dayNumber, place: item };
}

test('a park can outrank a museum on day 2 when a previous day already had a museum', () => {
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: otherMuseum,
    completedPreviousDayCoreStops: [previous(1, museum), previous(1, palace)],
  }).penalty, CROSS_DAY_DIVERSITY_PENALTY_ONE_DAY);
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: park,
    completedPreviousDayCoreStops: [previous(1, museum), previous(1, palace)],
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { previousDayCoreStops: [previous(1, museum)] },
    (input) => eligible(input.place.id === otherMuseum.id ? 70 : 72),
  );
  const withoutCrossDay = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    {},
    (input) => eligible(input.place.id === otherMuseum.id ? 70 : 72),
  );
  assert.deepEqual(withoutCrossDay.map((item) => item.id), [otherMuseum.id, park.id]);
  assert.ok(Math.abs((70 - 6) - 72) >= CORE_CANDIDATE_SCORE_GAP_V1);
  assert.deepEqual(ranked.map((item) => item.id), [park.id, otherMuseum.id]);
});

test('two previous days with the same group apply the 14-point cap', () => {
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: thirdMuseum,
    completedPreviousDayCoreStops: [
      previous(1, museum),
      previous(1, museum),
      previous(2, otherMuseum),
    ],
  }).penalty, CROSS_DAY_DIVERSITY_PENALTY_MANY_DAYS);
  assert.equal(CROSS_DAY_DIVERSITY_PENALTY_MANY_DAYS, 14);
});

test('unknown groups are never penalized', () => {
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: unnamed,
    completedPreviousDayCoreStops: [previous(1, museum)],
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [unnamed, park],
    { previousDayCoreStops: [previous(1, museum)] },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [unnamed.id, park.id]);
});

test('single-day trips keep a zero cross-day penalty', () => {
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: otherMuseum,
    completedPreviousDayCoreStops: [],
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { existingCoreStops: [museum] },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [park.id, otherMuseum.id]);
});

function coreStop(item: Place) {
  return {
    place: item,
    category: 'sight' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '',
    sourceQuery: item.name,
  };
}

test('all same-group candidates are still selected without extra searches', async () => {
  const withScore = { calls: 0, async search() {
    this.calls += 1;
    return [structuredClone(otherMuseum), structuredClone(thirdMuseum)];
  } };
  const legacy = { calls: 0, async search() {
    this.calls += 1;
    return [structuredClone(otherMuseum), structuredClone(thirdMuseum)];
  } };
  const extra = place({ id: 'amap:TOWER', name: '永定门城楼', latitude: 39.871, longitude: 116.393 });
  const plan: ResolvedTripPlanSuggestion = {
    title: '北京',
    summary: '',
    unresolved: [],
    days: [
      {
        dayNumber: 1,
        title: '第一天',
        summary: '',
        stops: [coreStop(museum), coreStop(park), coreStop(extra)],
      },
      {
        dayNumber: 2,
        title: '第二天',
        summary: '',
        stops: [coreStop(palace)],
      },
    ],
  };
  const completed = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'balanced',
    placeSearch: withScore,
    scoringContext: { tripIntent: { interestKeys: ['history'] } },
  });
  const without = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'balanced',
    placeSearch: legacy,
  });
  assert.equal(withScore.calls, legacy.calls);
  assert.equal(completed.days[1].stops.length, without.days[1].stops.length);
  assert.ok(completed.days[1].stops.some((stop) => (
    stop.place.id === otherMuseum.id || stop.place.id === thirdMuseum.id
  )));
});

test('same-day repeats stay on S3-A and are not double-counted as cross-day', () => {
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: otherMuseum,
    completedPreviousDayCoreStops: [],
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    {
      existingCoreStops: [museum],
      previousDayCoreStops: [],
    },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [park.id, otherMuseum.id]);
});

test('later days only read completed earlier cores and stay deterministic', () => {
  const context = {
    previousDayCoreStops: [previous(1, museum), previous(2, otherMuseum)],
  };
  const first = rerankCoreCompletionCandidatesV1(
    [thirdMuseum, park],
    context,
    () => eligible(70),
  );
  const second = rerankCoreCompletionCandidatesV1(
    [thirdMuseum, park],
    context,
    () => eligible(70),
  );
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: thirdMuseum,
    completedPreviousDayCoreStops: [previous(1, museum), previous(2, otherMuseum)],
  }).penalty, 14);
  assert.equal(calculateCrossDayDiversityPenaltyV1({
    candidate: park,
    completedPreviousDayCoreStops: [previous(1, museum), previous(2, otherMuseum)],
  }).penalty, 0);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.deepEqual(first.map((item) => item.id), [park.id, thirdMuseum.id]);
});

test('omitting previousDayCoreStops keeps the S2 S3-A S3-B order', () => {
  const evaluate = (input: { place: Place }) => eligible(input.place.id === otherMuseum.id ? 70 : 70);
  const without = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { existingCoreStops: [museum] },
    evaluate,
  );
  const empty = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { existingCoreStops: [museum], previousDayCoreStops: undefined },
    evaluate,
  );
  assert.deepEqual(without.map((item) => item.id), empty.map((item) => item.id));
});
