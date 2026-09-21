import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSameDayFatiguePenaltyV1,
} from '../server/services/trip-itinerary-fatigue-v1';
import {
  CORE_CANDIDATE_SCORE_GAP_V1,
  rerankCoreCompletionCandidatesV1,
} from '../server/services/trip-core-candidate-ranking-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { CandidateEvaluationV1 } from '../src/domain/trip/recommendation-scoring-v1';
import type { Place } from '../src/domain/trip/types';
import type { ResolvedTripPlanSuggestion, ResolvedTripPlaceStop } from '../server/services/trip-place-resolver';
import {
  HIGH_WALKING_BURDEN_V1,
  MAX_FATIGUE_PENALTY_V1,
} from '../src/domain/trip/itinerary-fatigue-v1';

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

const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.396 });
const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const hutong = place({ id: 'amap:HUTONG', name: '南锣鼓巷', category: 'activity', latitude: 39.937, longitude: 116.403 });
const hike = place({ id: 'amap:HIKE', name: '香山徒步', category: 'activity', latitude: 39.99, longitude: 116.19 });
const museum = place({ id: 'amap:NAT', name: '国家博物馆' });

const lowWalking = {
  partyContext: { partyType: 'parents' as const, hasElderly: true, mobilityRequirement: 'low_walking' as const },
  constraints: { excludedInterestKeys: [] as never[], lowWalking: true },
};

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

function coreStop(item: Place, minutes: number): ResolvedTripPlaceStop {
  return {
    place: item,
    category: 'sight',
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: minutes,
    reason: '核心地点。',
    sourceQuery: item.name,
  };
}

function plan(stops: ResolvedTripPlaceStop[]): ResolvedTripPlanSuggestion {
  return {
    title: '北京',
    summary: '',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '城区',
      summary: '',
      stops,
    }],
  };
}

test('without party or lowWalking, ordinary candidates are not penalized by default', () => {
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 90)],
  }).penalty, 0);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: palace,
    existingCoreStops: [coreStop(park, 90)],
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    { existingResolvedCores: [coreStop(park, 90)] },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [hutong.id, palace.id]);
});

test('parents, elderly and lowWalking penalize high walkingBurden candidates', () => {
  assert.ok(HIGH_WALKING_BURDEN_V1 <= 0.7);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 90)],
    ...lowWalking,
  }).penalty, 8);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: palace,
    existingCoreStops: [coreStop(park, 90)],
    ...lowWalking,
  }).penalty, 0);
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {
      existingResolvedCores: [coreStop(park, 90)],
      ...lowWalking,
    },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [palace.id, hutong.id]);
});

test('a 150-minute existing core stay adds extra low-walking fatigue', () => {
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 150)],
    ...lowWalking,
  }).penalty, 13);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: palace,
    existingCoreStops: [coreStop(park, 150)],
    ...lowWalking,
  }).penalty, 5);
});

test('cumulative core stay of 240 minutes adds extra low-walking fatigue and stays within 20', () => {
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 90), coreStop(museum, 150)],
    ...lowWalking,
  }).penalty, 18);
  assert.ok(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 150), coreStop(museum, 150)],
    ...lowWalking,
  }).penalty <= MAX_FATIGUE_PENALTY_V1);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: hutong,
    existingCoreStops: [coreStop(park, 150), coreStop(museum, 150)],
    constraints: { excludedInterestKeys: [] },
  }).penalty, 5);
});

test('unknown walking burden is not penalized', () => {
  const unknown = {
    ...palace,
    category: 'unknown_category' as Place['category'],
  };
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: unknown,
    existingCoreStops: [coreStop(park, 150)],
    ...lowWalking,
  }).penalty, 0);
  assert.equal(calculateSameDayFatiguePenaltyV1({
    candidate: {} as Place,
    existingCoreStops: [coreStop(park, 240)],
    ...lowWalking,
  }).penalty, 0);
});

test('all high-walking candidates are still selected without extra searches', async () => {
  const searchWithScore = {
    calls: 0,
    async search() {
      this.calls += 1;
      return [structuredClone(hutong), structuredClone(hike)];
    },
  };
  const searchLegacy = {
    calls: 0,
    async search() {
      this.calls += 1;
      return [structuredClone(hutong), structuredClone(hike)];
    },
  };
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([coreStop(park, 90)]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: searchWithScore,
    scoringContext: {
      partyContext: lowWalking.partyContext,
      constraints: { excludedInterestKeys: [], lowWalking: true },
    },
  });
  const withoutScore = await completeResolvedTripCorePlaces({
    plan: plan([coreStop(park, 90)]),
    destination: '北京',
    pace: 'balanced',
    placeSearch: searchLegacy,
  });
  assert.equal(searchWithScore.calls, searchLegacy.calls);
  assert.equal(completed.days[0].stops.length, withoutScore.days[0].stops.length);
  assert.ok(completed.days[0].stops.length >= 2);
  assert.ok(completed.days[0].stops.some((stop) => stop.place.id === hutong.id || stop.place.id === hike.id));
});

test('fatigue gaps below 8 keep the legacy order', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {
      existingResolvedCores: [coreStop(park, 90)],
      ...lowWalking,
    },
    (input) => eligible(input.place.id === hutong.id ? 70 : 64),
  );
  assert.ok(Math.abs((70 - 8) - 64) < CORE_CANDIDATE_SCORE_GAP_V1);
  assert.deepEqual(ranked.map((item) => item.id), [hutong.id, palace.id]);
});

test('illegal fatigue values fall back to zero without changing generation', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {
      existingResolvedCores: [{ place: park, suggestedDurationMinutes: Number.NaN }],
      partyContext: { partyType: 'solo' },
    },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [hutong.id, palace.id]);
});

test('diversity and fatigue failures stay independent', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {
      existingCoreStops: [museum],
      existingResolvedCores: [coreStop(park, 90)],
      ...lowWalking,
    },
    () => eligible(70),
  );
  assert.equal(ranked[0]?.id, palace.id);
});
