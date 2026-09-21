import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSameDayDiversityPenaltyV1,
  deriveCoreExperienceGroupV1,
} from '../server/services/trip-itinerary-diversity-v1';
import {
  CORE_CANDIDATE_SCORE_GAP_V1,
  rerankCoreCompletionCandidatesV1,
} from '../server/services/trip-core-candidate-ranking-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { CandidateEvaluationV1 } from '../src/domain/trip/recommendation-scoring-v1';
import type { Place } from '../src/domain/trip/types';
import type { PlaceSearchService, ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';

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
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.396 });
const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const hutong = place({ id: 'amap:HUTONG', name: '南锣鼓巷', category: 'activity', latitude: 39.937, longitude: 116.403 });
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

test('experience groups stay conservative and deterministic', () => {
  assert.equal(deriveCoreExperienceGroupV1(museum), 'museum');
  assert.equal(deriveCoreExperienceGroupV1(palace), 'heritage');
  assert.equal(deriveCoreExperienceGroupV1(park), 'park_garden');
  assert.equal(deriveCoreExperienceGroupV1(place({ id: 'amap:ST', name: '烟袋斜街', category: 'attraction' }), '北京 历史街区'), 'street_district');
  assert.equal(deriveCoreExperienceGroupV1(place({ id: 'amap:TOWER', name: '永定门城楼' })), 'landmark_architecture');
  assert.equal(deriveCoreExperienceGroupV1(hutong), 'activity');
  assert.equal(deriveCoreExperienceGroupV1(unnamed), 'unknown');
  assert.equal(deriveCoreExperienceGroupV1(place({ id: 'amap:CAFE', name: '咖啡店', category: 'cafe' })), 'unknown');
  assert.deepEqual(
    [deriveCoreExperienceGroupV1(museum), deriveCoreExperienceGroupV1(museum)],
    ['museum', 'museum'],
  );
});

test('same-day diversity penalty is 0, 10 or 25 and never filters', () => {
  assert.equal(calculateSameDayDiversityPenaltyV1({ candidate: unnamed, existingCoreStops: [museum] }), 0);
  assert.equal(calculateSameDayDiversityPenaltyV1({ candidate: park, existingCoreStops: [museum] }), 0);
  assert.equal(calculateSameDayDiversityPenaltyV1({ candidate: otherMuseum, existingCoreStops: [museum] }), 10);
  assert.equal(calculateSameDayDiversityPenaltyV1({
    candidate: otherMuseum,
    existingCoreStops: [museum, place({ id: 'amap:MIL', name: '军事博物馆' })],
  }), 25);
  assert.equal(calculateSameDayDiversityPenaltyV1({
    candidate: place({ id: 'amap:CAFE', name: '咖啡店', category: 'cafe' }),
    existingCoreStops: [museum],
  }), 0);
});

test('a nearby park can outrank a second museum when the adjusted gap reaches 8', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { existingCoreStops: [museum] },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [park.id, otherMuseum.id]);
});

test('a lone museum candidate is still selected when it is the only legal option', async () => {
  const search: PlaceSearchService = {
    async search() {
      return [structuredClone(otherMuseum)];
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
      stops: [{
        place: museum,
        category: 'sight',
        suggestedStartTime: '10:00',
        suggestedDurationMinutes: 90,
        reason: '核心地点。',
        sourceQuery: museum.name,
      }],
    }],
  };
  const completed = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'balanced',
    placeSearch: search,
    scoringContext: { tripIntent: { interestKeys: ['history'] } },
  });
  assert.equal(completed.days[0].stops.some((stop) => stop.place.id === otherMuseum.id), true);
  assert.equal(completed.days[0].stops.length, 2);
});

test('unknown groups keep the S2 or legacy order', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [unnamed, park],
    { existingCoreStops: [museum] },
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [unnamed.id, park.id]);
});

test('a diversity penalty below the 8-point threshold keeps legacy order', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [otherMuseum, park],
    { existingCoreStops: [museum] },
    (input) => eligible(input.place.id === otherMuseum.id ? 70 : 64),
  );
  assert.ok(Math.abs((70 - 10) - 64) < CORE_CANDIDATE_SCORE_GAP_V1);
  assert.deepEqual(ranked.map((item) => item.id), [otherMuseum.id, park.id]);
});

test('repeated diversity ranking is deterministic', () => {
  const context = { existingCoreStops: [museum] };
  const first = rerankCoreCompletionCandidatesV1([otherMuseum, park], context, () => eligible(70));
  const second = rerankCoreCompletionCandidatesV1([otherMuseum, park], context, () => eligible(70));
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
});
