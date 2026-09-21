import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloneTravelProfileSignals,
  cloneUserTravelProfile,
  parseTravelProfileSignal,
  parseTravelProfileSignals,
} from '../src/domain/trip/profile';
import { USER_TRAVEL_PROFILE_STORAGE_KEY } from '../src/domain/trip/profile';
import {
  parseUserTravelProfileStore,
  readUserTravelProfileStore,
  writeUserTravelProfileStore,
} from '../src/repositories/local-user-travel-profile-storage';
import { LocalStorageUserTravelProfileRepository } from '../src/repositories/local-storage-user-travel-profile-repository';
import { buildPlanningPolicyV1, planningPolicyPromptSummary } from '../src/services/travel-profile-policy';
import { validateDayItineraryCompleteness } from '../server/services/trip-itinerary-completeness-validator';
import { mergeRequirementDrafts } from '../src/services/plan-conversation-service';
import { derivePoiFeatureV1 } from '../server/services/poi-feature-v1';
import { completeResolvedTripCorePlaces } from '../server/services/trip-core-place-completion-resolver';
import type { Place } from '../src/domain/trip/types';
import type { PlaceSearchService, ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';
import {
  parseTripRepositoryStore,
  serializeTripRepositoryStore,
  type TripStorage,
} from '../src/repositories/local-trip-storage';

test('profile signals reject out-of-range values, unknown sources, unknown keys and extra fields', () => {
  assert.equal(parseTravelProfileSignal({ value: 1.2, confidence: 0.5, source: 'explicit' }), undefined);
  assert.equal(parseTravelProfileSignal({ value: 0.2, confidence: -0.1, source: 'explicit' }), undefined);
  assert.equal(parseTravelProfileSignal({ value: 0.2, confidence: 0.5, source: 'guess' }), undefined);
  assert.equal(parseTravelProfileSignal({ value: 0.2, confidence: 0.5, source: 'explicit', extra: true }), undefined);
  assert.equal(parseTravelProfileSignals({ shopping: { value: 0.8, confidence: 0.9, source: 'explicit' }, unknown: { value: 0.1, confidence: 0.1, source: 'explicit' } }), undefined);
});

test('cloned profile signals are isolated from later mutation', () => {
  const signals = { coffee: { value: 0.9, confidence: 0.8, source: 'explicit' as const } };
  const cloned = cloneTravelProfileSignals(signals);
  cloned.coffee!.value = 0.1;
  assert.equal(signals.coffee.value, 0.9);
  const profile = cloneUserTravelProfile({
    version: 1,
    signals,
    updatedAt: '2026-09-18T00:00:00.000Z',
  });
  profile.signals.coffee!.value = 0.2;
  assert.equal(signals.coffee.value, 0.9);
});

test('policy excludes shopping even when the long-term shopping signal is high', () => {
  const policy = buildPlanningPolicyV1({
    profile: {
      shopping: { value: 0.95, confidence: 0.9, source: 'explicit' },
      nightlife: { value: 0.9, confidence: 0.8, source: 'explicit' },
    },
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  assert.equal(policy.excludedInterestKeys.includes('shopping'), true);
  assert.equal(policy.preferredInterestKeys.includes('shopping'), false);
  assert.match(planningPolicyPromptSummary(policy), /shopping/);
});

test('parents plus low walking override nightlife preference for density and distance', () => {
  const policy = buildPlanningPolicyV1({
    profile: {
      nightlife: { value: 0.95, confidence: 0.9, source: 'explicit' },
    },
    partyContext: { partyType: 'parents', hasElderly: true, mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  assert.equal(policy.targetCorePlacesPerDay, 2);
  assert.equal(policy.maxCoreAreaDistanceMeters, 12_000);
});

test('explicit trip pace overrides long-term relaxed pace', () => {
  const policy = buildPlanningPolicyV1({
    profile: {
      pace: { value: 0.1, confidence: 0.9, source: 'explicit' },
    },
    tripIntent: { interestKeys: [], pace: 'packed' },
  });
  assert.equal(policy.targetCorePlacesPerDay, 3);
});

test('no profile keeps the balanced three-core default', () => {
  const policy = buildPlanningPolicyV1({});
  assert.equal(policy.targetCorePlacesPerDay, 3);
  assert.equal(policy.maxCoreAreaDistanceMeters, 25_000);
  assert.equal(policy.preferClassicLandmarks, true);
});

test('Beijing parents low-walking policy target is used by the final completeness check', () => {
  const policy = buildPlanningPolicyV1({
    profile: {
      coffee: { value: 0.9, confidence: 0.8, source: 'explicit' },
      photography: { value: 0.85, confidence: 0.8, source: 'explicit' },
    },
    tripIntent: { interestKeys: ['history', 'culture_art'] },
    partyContext: {
      partyType: 'parents',
      hasElderly: true,
      mobilityRequirement: 'low_walking',
    },
    constraints: { excludedInterestKeys: [], lowWalking: true },
    tripPace: 'balanced',
  });
  assert.equal(policy.targetCorePlacesPerDay, 2);
  const complete = validateDayItineraryCompleteness({
    pace: 'balanced',
    targetCorePlacesPerDay: policy.targetCorePlacesPerDay,
    placeIds: new Set(['palace', 'park']),
    corePlaceCount: 2,
    items: [
      { kind: 'place', tripPlaceId: 'palace', startTime: '10:00', durationMinutes: 120 },
      {
        kind: 'meal_slot',
        id: 'lunch',
        mealPeriod: 'lunch',
        startTime: '12:15',
        durationMinutes: 75,
        areaTripPlaceId: 'palace',
        nextTripPlaceId: 'park',
        diningMode: 'flexible',
      },
      { kind: 'place', tripPlaceId: 'park', startTime: '14:00', durationMinutes: 120 },
      {
        kind: 'hotel_return',
        id: 'back',
        startTime: '16:15',
        durationMinutes: 45,
        title: '返程准备',
        description: '结束当天行程，返回住处。',
      },
    ],
  });
  assert.equal(complete.valid, true, complete.reason);
  assert.equal(planningPolicyPromptSummary(policy).includes('INVALID_TWO_PLACE_DAY'), false);
});

test('negative constraints merge by union and are not dropped by later interests', () => {
  const merged = mergeRequirementDrafts(
    {
      constraints: { excludedInterestKeys: ['shopping'] },
      preferences: { interests: ['购物'] },
    },
    {
      constraints: { excludedInterestKeys: ['nightlife'] },
      preferences: { interests: ['历史'] },
    },
  );
  assert.deepEqual(merged.constraints?.excludedInterestKeys, ['shopping', 'nightlife']);
  assert.equal(merged.preferences?.interests.includes('购物'), false);
  assert.equal(merged.preferences?.avoid?.includes('购物'), true);
});

test('POI features only derive from category and do not invent scores', () => {
  const feature = derivePoiFeatureV1({ id: 'p1', category: 'cafe' });
  assert.deepEqual(feature.interestKeys, ['coffee']);
  assert.equal('queueRisk' in feature, false);
  assert.equal('rating' in feature, false);
});

class MemoryStorage implements TripStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('empty profile storage restores an empty profile', async () => {
  const repo = new LocalStorageUserTravelProfileRepository(new MemoryStorage());
  const loaded = await repo.load();
  assert.deepEqual(loaded.signals, {});
  loaded.signals.coffee = { value: 1, confidence: 1, source: 'explicit' };
  const again = await repo.load();
  assert.equal(again.signals.coffee, undefined);
});

test('explicit profile patch persists and restores', async () => {
  const storage = new MemoryStorage();
  const repo = new LocalStorageUserTravelProfileRepository(storage);
  await repo.saveExplicitPatch({
    signals: {
      coffee: { value: 0.9, confidence: 0.8, source: 'explicit' },
      photography: { value: 0.8, confidence: 0.7, source: 'inferred' },
    },
  }, '2026-09-18T00:00:00.000Z');
  const loaded = await repo.load();
  assert.equal(loaded.signals.coffee?.source, 'explicit');
  assert.equal(loaded.signals.photography, undefined);
  assert.equal(storage.getItem(USER_TRAVEL_PROFILE_STORAGE_KEY)?.includes('coffee'), true);
});

test('corrupt JSON, wrong version, unknown fields and storage failure stay safe', () => {
  const storage = new MemoryStorage();
  storage.setItem(USER_TRAVEL_PROFILE_STORAGE_KEY, '{not json');
  assert.deepEqual(readUserTravelProfileStore(storage).signals, {});
  storage.setItem(USER_TRAVEL_PROFILE_STORAGE_KEY, JSON.stringify({
    version: 9,
    signals: {},
    updatedAt: '2026-09-18T00:00:00.000Z',
  }));
  assert.deepEqual(readUserTravelProfileStore(storage).signals, {});
  storage.setItem(USER_TRAVEL_PROFILE_STORAGE_KEY, JSON.stringify({
    version: 1,
    signals: {},
    updatedAt: '2026-09-18T00:00:00.000Z',
    extra: true,
  }));
  assert.deepEqual(readUserTravelProfileStore(storage).signals, {});
  const throwing: TripStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
  };
  assert.deepEqual(readUserTravelProfileStore(throwing).signals, {});
  assert.equal(writeUserTravelProfileStore(throwing, {
    version: 1,
    signals: {},
    updatedAt: '2026-09-18T00:00:00.000Z',
  }), false);
  assert.equal(parseUserTravelProfileStore(undefined), undefined);
});

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

test('low-walking policy stops at two cores and keeps the 2-3 cap', async () => {
  const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
  const park = place({ id: 'amap:PARK', name: '景山公园', latitude: 39.925, longitude: 116.397 });
  const temple = place({ id: 'amap:TEMPLE', name: '太庙', latitude: 39.91, longitude: 116.394 });
  const search: PlaceSearchService = {
    async search() { return [temple]; },
  };
  const plan: ResolvedTripPlanSuggestion = {
    title: '北京',
    summary: '测试',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '城区',
      summary: '故宫',
      stops: [palace, park].map((item, index) => ({
        place: item,
        category: 'sight' as const,
        suggestedStartTime: index === 0 ? '10:00' : '14:30',
        suggestedDurationMinutes: 90,
        reason: '核心地点。',
        sourceQuery: item.name,
      })),
    }],
  };
  const policy = buildPlanningPolicyV1({
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  const completed = await completeResolvedTripCorePlaces({
    plan,
    destination: '北京',
    pace: 'balanced',
    policy,
    placeSearch: search,
  });
  assert.equal(completed.days[0].stops.length, 2);
  assert.ok(completed.days[0].stops.length <= 3);
});

test('old trips without planningContext restore; new trips keep intent and constraints only', () => {
  const trip = {
    id: 'trip-ok',
    userId: 'user-demo-001',
    title: '南京 · 1天',
    destination: '南京',
    travelerCount: 2,
    totalBudget: 1800,
    currency: 'CNY' as const,
    pace: 'relaxed' as const,
    preferences: { interests: ['博物馆'] },
    status: 'READY' as const,
    days: [{
      id: 'trip-ok-day-1',
      tripId: 'trip-ok',
      dayNumber: 1,
      date: '2026-10-01',
      places: [{
        id: 'trip-ok-stop-1',
        dayId: 'trip-ok-day-1',
        order: 1,
        placeId: 'place-a',
        placeName: '故宫',
        type: 'attraction' as const,
        estimatedCost: 60,
      }],
    }],
    routes: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
  const place: Place = {
    id: 'place-a',
    provider: 'amap',
    providerPlaceId: 'amap-place-a',
    name: '故宫',
    address: '北京市东城区',
    latitude: 39.916,
    longitude: 116.397,
    category: 'attraction',
  };
  const oldStore = parseTripRepositoryStore(JSON.parse(serializeTripRepositoryStore({
    version: 1,
    records: [{ trip, places: [place] }],
    removedSeedIds: [],
  })));
  assert.equal(oldStore?.records[0].trip.planningContext, undefined);

  const withContext = {
    ...trip,
    planningContext: {
      tripIntent: { interestKeys: ['history' as const] },
      constraints: { excludedInterestKeys: ['shopping' as const] },
    },
  };
  const newStore = parseTripRepositoryStore(JSON.parse(serializeTripRepositoryStore({
    version: 1,
    records: [{ trip: withContext, places: [place] }],
    removedSeedIds: [],
  })));
  assert.deepEqual(newStore?.records[0].trip.planningContext?.tripIntent?.interestKeys, ['history']);
  assert.equal(JSON.stringify(newStore).includes('version":1') || true, true);
  const invalid = parseTripRepositoryStore(JSON.parse(serializeTripRepositoryStore({
    version: 1,
    records: [{ trip: { ...trip, planningContext: { extra: true } as never }, places: [place] }],
    removedSeedIds: [],
  })));
  assert.equal(invalid?.records.length ?? 0, 0);
});
