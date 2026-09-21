import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  diagnoseMustVisitCoverageV1,
  evaluateCoreCandidateV1,
  scoreRouteFitV1,
} from '../server/services/trip-candidate-evaluator-v1';
import type { Place } from '../src/domain/trip/types';
import type { PlanningPolicyV1 } from '../src/domain/trip/profile';
import { DEFAULT_CORE_AREA_DISTANCE_METERS, LOW_WALKING_CORE_AREA_DISTANCE_METERS } from '../src/domain/trip/profile';

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

const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.396 });
const farPark = place({ id: 'amap:FAR', name: '颐和园', latitude: 39.999, longitude: 116.275 });

const defaultPolicy: PlanningPolicyV1 = {
  targetCorePlacesPerDay: 3,
  maxCoreAreaDistanceMeters: DEFAULT_CORE_AREA_DISTANCE_METERS,
  preferredInterestKeys: [],
  excludedInterestKeys: [],
  preferClassicLandmarks: true,
  preferIndoor: false,
  preferOutdoor: false,
};

const lowWalkingPolicy: PlanningPolicyV1 = {
  ...defaultPolicy,
  targetCorePlacesPerDay: 2,
  maxCoreAreaDistanceMeters: LOW_WALKING_CORE_AREA_DISTANCE_METERS,
};

test('identical inputs produce identical constraint and score results', () => {
  const input = {
    place: palace,
    usedPlaceIds: new Set<string>(),
    anchors: [park],
    policy: defaultPolicy,
    profileSignals: {
      history: { value: 0.9, confidence: 0.8, source: 'explicit' as const },
    },
    tripIntent: { interestKeys: ['history' as const] },
    partyContext: { partyType: 'parents' as const, hasElderly: true, mobilityRequirement: 'low_walking' as const },
    constraints: { excludedInterestKeys: [], lowWalking: true },
    routeDetourMinutes: 12,
  };
  const first = evaluateCoreCandidateV1(input);
  const second = evaluateCoreCandidateV1(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.constraints.eligible, true);
  assert.ok(first.score);
});

test('used place ids are rejected as DUPLICATE_PLACE', () => {
  const result = evaluateCoreCandidateV1({
    place: palace,
    usedPlaceIds: new Set(['amap:PALACE']),
  });
  assert.equal(result.constraints.eligible, false);
  assert.deepEqual(result.constraints.reasons, ['DUPLICATE_PLACE']);
  assert.equal(result.score, undefined);
});

test('non-core categories are rejected as UNSUPPORTED_CATEGORY', () => {
  for (const category of ['restaurant', 'cafe', 'shopping', 'hotel', 'transport'] as const) {
    const result = evaluateCoreCandidateV1({
      place: place({ id: `amap:${category}`, name: category, category }),
    });
    assert.equal(result.constraints.eligible, false);
    assert.ok(result.constraints.reasons.includes('UNSUPPORTED_CATEGORY'));
    assert.equal(result.score, undefined);
  }
});

test('invalid coordinates are rejected', () => {
  const result = evaluateCoreCandidateV1({
    place: place({ id: 'amap:BAD', name: '无效点', latitude: Number.NaN, longitude: 200 }),
  });
  assert.equal(result.constraints.eligible, false);
  assert.ok(result.constraints.reasons.includes('INVALID_COORDINATES'));
});

test('low-walking 12km distance rejects far anchors while default 25km keeps them', () => {
  const low = evaluateCoreCandidateV1({
    place: farPark,
    anchors: [palace],
    policy: lowWalkingPolicy,
  });
  const standard = evaluateCoreCandidateV1({
    place: farPark,
    anchors: [palace],
    policy: defaultPolicy,
  });
  assert.equal(low.constraints.eligible, false);
  assert.ok(low.constraints.reasons.includes('OUTSIDE_MAX_CORE_DISTANCE'));
  assert.equal(standard.constraints.eligible, true);
});

test('missing profile, intent, party and route stay at a neutral 50 and do not zero the total', () => {
  const result = evaluateCoreCandidateV1({ place: palace });
  assert.equal(result.constraints.eligible, true);
  assert.deepEqual(result.score?.breakdown, {
    preferenceMatch: 50,
    tripIntentMatch: 50,
    partyFit: 50,
    routeFit: 50,
    dataConfidence: 100,
  });
  assert.equal(result.score?.total, 53);
});

test('history intent raises attraction match and coffee cannot make a cafe a core candidate', () => {
  const history = evaluateCoreCandidateV1({
    place: palace,
    tripIntent: { interestKeys: ['history'] },
  });
  const photography = evaluateCoreCandidateV1({
    place: place({ id: 'amap:ACT', name: '胡同漫步', category: 'activity' }),
    tripIntent: { interestKeys: ['photography'] },
  });
  const coffeeCafe = evaluateCoreCandidateV1({
    place: place({ id: 'amap:CAFE', name: '咖啡店', category: 'cafe' }),
    tripIntent: { interestKeys: ['coffee'] },
    profileSignals: {
      coffee: { value: 0.95, confidence: 0.9, source: 'explicit' },
    },
  });
  assert.ok((history.score?.breakdown.tripIntentMatch ?? 0) > 50);
  assert.ok((photography.score?.breakdown.tripIntentMatch ?? 0) > 50);
  assert.equal(coffeeCafe.constraints.eligible, false);
  assert.ok(coffeeCafe.constraints.reasons.includes('UNSUPPORTED_CATEGORY'));
});

test('low-walking party prefers a lower walking burden and absence of party stays 50', () => {
  const attraction = evaluateCoreCandidateV1({
    place: palace,
    partyContext: { partyType: 'parents', hasElderly: true, mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  const activity = evaluateCoreCandidateV1({
    place: place({ id: 'amap:ACT', name: '胡同漫步', category: 'activity' }),
    partyContext: { partyType: 'parents', hasElderly: true, mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  const none = evaluateCoreCandidateV1({ place: palace });
  assert.ok((attraction.score?.breakdown.partyFit ?? 0) > (activity.score?.breakdown.partyFit ?? 0));
  assert.equal(none.score?.breakdown.partyFit, 50);
});

test('route fit uses the fixed 5/15/30/45 minute buckets and stays 50 without real detour', () => {
  assert.equal(scoreRouteFitV1(5), 100);
  assert.equal(scoreRouteFitV1(15), 80);
  assert.equal(scoreRouteFitV1(30), 50);
  assert.equal(scoreRouteFitV1(45), 20);
  assert.equal(scoreRouteFitV1(46), 0);
  assert.equal(scoreRouteFitV1(undefined), 50);
  assert.equal(evaluateCoreCandidateV1({ place: palace }).score?.breakdown.routeFit, 50);
});

test('inferred profile signals are ignored and shopping exclusion does not kill attractions', () => {
  const inferred = evaluateCoreCandidateV1({
    place: palace,
    profileSignals: {
      history: { value: 0.95, confidence: 0.9, source: 'inferred' },
    },
  });
  const excludedShopping = evaluateCoreCandidateV1({
    place: palace,
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  const shopping = evaluateCoreCandidateV1({
    place: place({ id: 'amap:MALL', name: '商场', category: 'shopping' }),
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  assert.equal(inferred.score?.breakdown.preferenceMatch, 50);
  assert.equal(excludedShopping.constraints.eligible, true);
  assert.ok(shopping.constraints.reasons.includes('UNSUPPORTED_CATEGORY'));
  assert.ok(shopping.constraints.reasons.includes('EXCLUDED_INTEREST'));
});

test('mustVisit coverage is diagnostic only and does not become a hard constraint', () => {
  const coverage = diagnoseMustVisitCoverageV1({
    mustVisit: ['故宫博物院', '未出现的地点'],
    selectedNames: ['故宫博物院', '景山公园'],
  });
  assert.deepEqual(coverage, {
    requested: ['故宫博物院', '未出现的地点'],
    matched: ['故宫博物院'],
  });
  const result = evaluateCoreCandidateV1({ place: palace });
  assert.equal(result.constraints.reasons.includes('DUPLICATE_PLACE' as never) || result.constraints.eligible, true);
  assert.equal(JSON.stringify(result).includes('mustVisit'), false);
});

test('shadow scoring types and reasons stay off public trip, API and display surfaces', () => {
  const roots = [
    readFileSync(join(process.cwd(), 'src/services/trip-display.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/services/bff-trip-generation-service.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'server/routes/trip-generate.ts'), 'utf8'),
  ].join('\n');
  assert.equal(roots.includes('CandidateScoreResultV1'), false);
  assert.equal(roots.includes('preferenceMatch'), false);
  assert.equal(roots.includes('shadowEvaluateCoreCandidateV1'), false);
});
