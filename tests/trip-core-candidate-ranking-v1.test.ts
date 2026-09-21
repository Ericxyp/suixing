import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeResolvedTripCorePlaces,
  coreCompletionQueries,
} from '../server/services/trip-core-place-completion-resolver';
import {
  CORE_CANDIDATE_SCORE_GAP_V1,
  rerankCoreCompletionCandidatesV1,
} from '../server/services/trip-core-candidate-ranking-v1';
import type { CandidateEvaluationV1 } from '../src/domain/trip/recommendation-scoring-v1';
import type { Place } from '../src/domain/trip/types';
import type { PlanningPolicyV1 } from '../src/domain/trip/profile';
import {
  DEFAULT_CORE_AREA_DISTANCE_METERS,
  LOW_WALKING_CORE_AREA_DISTANCE_METERS,
} from '../src/domain/trip/profile';
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

const hutong = place({ id: 'amap:HUTONG', name: '南锣鼓巷', category: 'activity', latitude: 39.937, longitude: 116.403 });
const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.396 });
const far = place({ id: 'amap:FAR', name: '颐和园', latitude: 39.999, longitude: 116.275 });

const lowWalkingPolicy: PlanningPolicyV1 = {
  targetCorePlacesPerDay: 2,
  maxCoreAreaDistanceMeters: LOW_WALKING_CORE_AREA_DISTANCE_METERS,
  preferredInterestKeys: ['history'],
  excludedInterestKeys: [],
  preferClassicLandmarks: true,
  preferIndoor: false,
  preferOutdoor: false,
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

test('controlled ranking is deterministic', () => {
  const legacy = [hutong, palace, park];
  const context = {
    usedPlaceIds: new Set<string>(),
    anchors: [park],
    policy: lowWalkingPolicy,
    tripIntent: { interestKeys: ['history' as const] },
    partyContext: {
      partyType: 'parents' as const,
      hasElderly: true,
      mobilityRequirement: 'low_walking' as const,
    },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  };
  const first = rerankCoreCompletionCandidatesV1(legacy, context);
  const second = rerankCoreCompletionCandidatesV1(legacy, context);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.deepEqual(legacy.map((item) => item.id), ['amap:HUTONG', 'amap:PALACE', 'amap:PARK']);
});

test('a score gap of at least 8 can promote a later legacy candidate', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {},
    (input) => eligible(input.place.id === palace.id ? 80 : 60),
  );
  assert.deepEqual(ranked.map((item) => item.id), [palace.id, hutong.id]);
  assert.ok(80 - 60 >= CORE_CANDIDATE_SCORE_GAP_V1);
});

test('a score gap below 8 keeps the legacy order', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {},
    (input) => eligible(input.place.id === palace.id ? 56 : 50),
  );
  assert.deepEqual(ranked.map((item) => item.id), [hutong.id, palace.id]);
});

test('tied scores keep the explicit legacy index order', () => {
  const ranked = rerankCoreCompletionCandidatesV1(
    [hutong, palace, park],
    {},
    () => eligible(70),
  );
  assert.deepEqual(ranked.map((item) => item.id), [hutong.id, palace.id, park.id]);
});

test('evaluator errors or illegal scores fall back to the untouched legacy order', () => {
  const thrown = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {},
    () => {
      throw new Error('score failed');
    },
  );
  const nan = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {},
    () => eligible(Number.NaN),
  );
  const over = rerankCoreCompletionCandidatesV1(
    [hutong, palace],
    {},
    () => eligible(140),
  );
  assert.deepEqual(thrown.map((item) => item.id), [hutong.id, palace.id]);
  assert.deepEqual(nan.map((item) => item.id), [hutong.id, palace.id]);
  assert.deepEqual(over.map((item) => item.id), [hutong.id, palace.id]);
});

test('history plus low walking prefers a stronger cultural attraction when the gap is large', () => {
  const ranked = rerankCoreCompletionCandidatesV1([hutong, palace], {
    usedPlaceIds: new Set(),
    anchors: [park],
    policy: lowWalkingPolicy,
    tripIntent: { interestKeys: ['history'] },
    partyContext: { partyType: 'parents', hasElderly: true, mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  assert.equal(ranked[0]?.id, palace.id);
});

test('neutral context keeps the exact legacy order', () => {
  const legacy = [hutong, palace, park];
  const ranked = rerankCoreCompletionCandidatesV1(legacy, {});
  assert.deepEqual(ranked.map((item) => item.id), legacy.map((item) => item.id));
});

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
  calls = 0;

  constructor(private readonly results: Place[]) {}

  async search(): Promise<Place[]> {
    this.calls += 1;
    return this.results.map((item) => structuredClone(item));
  }
}

test('core completion without scoringContext stays on legacy selection', async () => {
  const search = new FakeSearch([hutong, palace]);
  const withoutScore = await completeResolvedTripCorePlaces({
    plan: plan([park]),
    destination: '北京',
    pace: 'balanced',
    policy: {
      ...lowWalkingPolicy,
      maxCoreAreaDistanceMeters: DEFAULT_CORE_AREA_DISTANCE_METERS,
    },
    placeSearch: search,
  });
  const withNeutral = await completeResolvedTripCorePlaces({
    plan: plan([park]),
    destination: '北京',
    pace: 'balanced',
    policy: {
      ...lowWalkingPolicy,
      maxCoreAreaDistanceMeters: DEFAULT_CORE_AREA_DISTANCE_METERS,
    },
    placeSearch: new FakeSearch([hutong, palace]),
    scoringContext: {},
  });
  assert.equal(withoutScore.days[0].stops[1]?.place.id, withNeutral.days[0].stops[1]?.place.id);
  assert.equal(search.calls, 1);
});

test('hard filters still drop hotel, cafe, shopping and far low-walking candidates', async () => {
  const cafe = place({ id: 'amap:CAFE', name: '咖啡店', category: 'cafe' });
  const hotel = place({ id: 'amap:HOTEL', name: '如家酒店', category: 'hotel' });
  const mall = place({ id: 'amap:MALL', name: '王府井百货', category: 'shopping' });
  const search = new FakeSearch([cafe, hotel, mall, far, palace]);
  const completed = await completeResolvedTripCorePlaces({
    plan: plan([park]),
    destination: '北京',
    pace: 'balanced',
    policy: lowWalkingPolicy,
    placeSearch: search,
    scoringContext: {
      profileSignals: {
        coffee: { value: 0.99, confidence: 0.9, source: 'explicit' },
        shopping: { value: 0.99, confidence: 0.9, source: 'explicit' },
      },
      tripIntent: { interestKeys: ['coffee', 'shopping', 'history'] },
      partyContext: { partyType: 'parents', mobilityRequirement: 'low_walking' },
      constraints: { excludedInterestKeys: [], lowWalking: true },
    },
  });
  const added = completed.days[0].stops.map((stop) => stop.place.category);
  assert.equal(added.includes('cafe'), false);
  assert.equal(added.includes('hotel'), false);
  assert.equal(added.includes('shopping'), false);
  assert.equal(completed.days[0].stops.some((stop) => stop.place.id === far.id), false);
  assert.equal(completed.days[0].stops.some((stop) => stop.place.id === palace.id), true);
  assert.equal(coreCompletionQueries({
    destination: '北京',
    day: { title: '城区经典', dayNumber: 1 },
    cores: plan([park]).days[0].stops,
    preferenceTerms: ['咖啡', '拍照', 'history'],
    hasExplicitTravelPreferences: true,
  }).some((query) => query.includes('咖啡 景点')), false);
});
