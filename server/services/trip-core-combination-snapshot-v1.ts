import type { Place, TripDay, TripPlace } from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TravelProfileSignals,
  TripConstraintsV1,
  TripIntentV1,
} from '../../src/domain/trip/profile';
import {
  CANARY_CORE_COMPLETION_MAX_DISTANCE_METERS_V1,
  CANARY_CORE_COMPLETION_SCORE_GAP_V1,
  CORE_COMBINATION_SNAPSHOT_LIMIT_V1,
  CORE_COMBINATION_SNAPSHOT_MAX_SLOTS_V1,
} from '../../src/domain/trip/core-combination-snapshot-v1';
import { calculateSameDayDiversityPenaltyV1 } from './trip-itinerary-diversity-v1';
import { calculateSameDayFatiguePenaltyV1 } from './trip-itinerary-fatigue-v1';
import { calculateCrossDayDiversityPenaltyV1 } from './trip-cross-day-diversity-v1';
import { clampCandidateScore, scoreCoreCandidateV1 } from './trip-candidate-evaluator-v1';
import { evaluateDayCombinationV1 } from './trip-day-combination-evaluator-v1';
import { haversineMeters, isFiniteGeoPoint } from './trip-route-enricher';
import type { CoreCandidateRankingContextV1 } from './trip-core-candidate-ranking-v1';
import type { ResolvedTripPlaceStop } from './trip-place-resolver';

const CORE_SNAPSHOT_CATEGORIES = new Set<Place['category']>(['attraction', 'activity']);

export interface CoreCandidateSnapshotV1 {
  place: Place;
  adjustedScore: number;
  legacyIndex: number;
}

export interface CoreCompletionSlotSnapshotV1 {
  dayNumber: number;
  slotIndex: number;
  candidates: readonly CoreCandidateSnapshotV1[];
}

export interface DayCoreCombinationSnapshotV1 {
  dayNumber: number;
  combinations: readonly {
    placeIds: readonly string[];
    preRouteScore: number;
  }[];
}

function clampScore(value: number): number {
  return clampCandidateScore(value);
}

function safePenalty(read: () => number): number {
  try {
    const value = read();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 0;
    }
    return value;
  } catch {
    return 0;
  }
}

export function snapshotAdjustedScoreV1(
  place: Place,
  context?: CoreCandidateRankingContextV1,
): number {
  try {
    const total = scoreCoreCandidateV1({
      place,
      usedPlaceIds: context?.usedPlaceIds,
      anchors: context?.anchors,
      policy: context?.policy,
      profileSignals: context?.profileSignals,
      tripIntent: context?.tripIntent,
      partyContext: context?.partyContext,
      constraints: context?.constraints,
      routeDetourMinutes: context?.routeDetourMinutes,
    }).total;
    const diversity = safePenalty(() => calculateSameDayDiversityPenaltyV1({
      candidate: place,
      existingCoreStops: context?.existingCoreStops,
      queryText: context?.queryText,
    }));
    const fatigue = safePenalty(() => calculateSameDayFatiguePenaltyV1({
      candidate: place,
      existingCoreStops: context?.existingResolvedCores ?? [],
      partyContext: context?.partyContext,
      constraints: context?.constraints,
      planningPolicy: context?.policy
        ? { targetCorePlacesPerDay: context.policy.targetCorePlacesPerDay }
        : undefined,
    }).penalty);
    const crossDay = safePenalty(() => {
      if (!context?.previousDayCoreStops) {
        return 0;
      }
      return calculateCrossDayDiversityPenaltyV1({
        candidate: place,
        completedPreviousDayCoreStops: context.previousDayCoreStops,
        queryText: context.queryText,
      }).penalty;
    });
    return Math.min(100, Math.max(0, total - diversity - fatigue - crossDay));
  } catch {
    return 50;
  }
}

export function snapshotCoreCompletionCandidatesV1(
  ranked: readonly Place[],
  legacyRanked: readonly Place[] = ranked,
  context?: CoreCandidateRankingContextV1,
): CoreCandidateSnapshotV1[] {
  const snapshots: CoreCandidateSnapshotV1[] = [];
  for (const place of ranked) {
    if (snapshots.length >= CORE_COMBINATION_SNAPSHOT_LIMIT_V1) {
      break;
    }
    if (!CORE_SNAPSHOT_CATEGORIES.has(place.category)) {
      continue;
    }
    const legacyIndex = legacyRanked.findIndex((item) => item.id === place.id);
    snapshots.push({
      place: { ...place },
      adjustedScore: snapshotAdjustedScoreV1(place, context),
      legacyIndex: legacyIndex >= 0 ? legacyIndex : snapshots.length,
    });
  }
  return snapshots;
}

export function enumerateCoreCompletionCombinationsV1(
  slots: readonly CoreCompletionSlotSnapshotV1[],
): Array<{ placeIds: readonly string[] }> {
  const limited = slots
    .slice(0, CORE_COMBINATION_SNAPSHOT_MAX_SLOTS_V1)
    .map((slot) => slot.candidates.slice(0, CORE_COMBINATION_SNAPSHOT_LIMIT_V1));
  const [firstSlot, secondSlot] = limited;
  if (!firstSlot || firstSlot.length === 0) {
    return [];
  }
  if (!secondSlot || secondSlot.length === 0) {
    return firstSlot.map((candidate) => ({ placeIds: [candidate.place.id] }));
  }
  const combinations: Array<{ placeIds: readonly string[] }> = [];
  for (const first of firstSlot) {
    for (const second of secondSlot) {
      if (first.place.id === second.place.id) {
        continue;
      }
      combinations.push({ placeIds: [first.place.id, second.place.id] });
    }
  }
  return combinations;
}

function asTripPlace(place: Place, durationMinutes: number, order: number, dayId: string): TripPlace {
  return {
    id: `shadow:${place.id}`,
    dayId,
    order,
    placeId: place.id,
    placeName: place.name,
    type: place.category,
    durationMinutes,
    estimatedCost: 0,
  };
}

function asTripDay(dayNumber: number, places: TripPlace[]): TripDay {
  return {
    id: `shadow-day-${dayNumber}`,
    tripId: 'shadow',
    dayNumber,
    date: '1970-01-01',
    places,
  };
}

export function scorePreRouteCoreCombinationV1(input: {
  dayNumber: number;
  originalCores: readonly ResolvedTripPlaceStop[];
  comboPlaces: readonly Place[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  previousDayCoreStops?: CoreCandidateRankingContextV1['previousDayCoreStops'];
}): number {
  const dayId = `shadow-day-${input.dayNumber}`;
  const tripPlaces: TripPlace[] = [];
  const catalog: Place[] = [];
  for (const stop of input.originalCores) {
    tripPlaces.push(asTripPlace(
      stop.place,
      stop.suggestedDurationMinutes ?? 90,
      tripPlaces.length + 1,
      dayId,
    ));
    catalog.push(stop.place);
  }
  for (const place of input.comboPlaces) {
    tripPlaces.push(asTripPlace(place, 90, tripPlaces.length + 1, dayId));
    catalog.push(place);
  }
  const scored = evaluateDayCombinationV1({
    day: asTripDay(input.dayNumber, tripPlaces),
    places: catalog,
    routes: [],
    policy: input.policy,
    profileSignals: input.profileSignals,
    tripIntent: input.tripIntent,
    partyContext: input.partyContext,
    constraints: input.constraints,
  });
  const penalties = input.comboPlaces.map((place) => safePenalty(() => {
    if (!input.previousDayCoreStops) {
      return 0;
    }
    return calculateCrossDayDiversityPenaltyV1({
      candidate: place,
      completedPreviousDayCoreStops: input.previousDayCoreStops,
    }).penalty;
  }));
  const avgPenalty = penalties.length === 0
    ? 0
    : penalties.reduce((sum, value) => sum + value, 0) / penalties.length;
  return clampScore(scored.total - avgPenalty);
}

export function scoreDayCoreCombinationSnapshotV1(input: {
  dayNumber: number;
  slots: readonly CoreCompletionSlotSnapshotV1[];
  originalCores: readonly ResolvedTripPlaceStop[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  previousDayCoreStops?: CoreCandidateRankingContextV1['previousDayCoreStops'];
}): DayCoreCombinationSnapshotV1 {
  const byId = new Map<string, Place>();
  for (const slot of input.slots) {
    for (const candidate of slot.candidates) {
      byId.set(candidate.place.id, candidate.place);
    }
  }
  const combinations = enumerateCoreCompletionCombinationsV1(input.slots).map((item) => ({
    placeIds: item.placeIds,
    preRouteScore: scorePreRouteCoreCombinationV1({
      dayNumber: input.dayNumber,
      originalCores: input.originalCores,
      comboPlaces: item.placeIds.flatMap((id) => {
        const place = byId.get(id);
        return place ? [place] : [];
      }),
      policy: input.policy,
      profileSignals: input.profileSignals,
      tripIntent: input.tripIntent,
      partyContext: input.partyContext,
      constraints: input.constraints,
      previousDayCoreStops: input.previousDayCoreStops,
    }),
  }));
  return {
    dayNumber: input.dayNumber,
    combinations,
  };
}

export function runCoreCombinationSnapshotShadowV1(work: () => void): void {
  try {
    work();
  } catch {
    // Shadow Mode must never affect generation, logging, or HTTP.
  }
}

export interface CanaryCoreCompletionCandidateV1 {
  place: Place;
  preRouteScore: number;
  suggestedStartTime: string;
  suggestedDurationMinutes: number;
  rerankIndex: number;
}

function isUsableCanaryScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCanaryCoreCategory(place: Place): boolean {
  return CORE_SNAPSHOT_CATEGORIES.has(place.category);
}

export function selectCanaryCoreCompletionCandidateV1(input: {
  baseline: CanaryCoreCompletionCandidateV1;
  alternatives?: readonly CanaryCoreCompletionCandidateV1[];
  missingCoreCount: number;
  scoringContext?: unknown;
}): Place {
  const baselinePlace = input.baseline.place;
  try {
    if (!input.scoringContext) {
      return baselinePlace;
    }
    if (input.missingCoreCount !== 1) {
      return baselinePlace;
    }
    if (!isCanaryCoreCategory(baselinePlace) || !isFiniteGeoPoint(baselinePlace)) {
      return baselinePlace;
    }
    if (!isUsableCanaryScore(input.baseline.preRouteScore)) {
      return baselinePlace;
    }
    if (
      typeof input.baseline.suggestedStartTime !== 'string'
      || input.baseline.suggestedStartTime.trim() === ''
      || !Number.isFinite(input.baseline.suggestedDurationMinutes)
    ) {
      return baselinePlace;
    }
    const eligible: CanaryCoreCompletionCandidateV1[] = [];
    for (const alternative of input.alternatives ?? []) {
      if (alternative.place.id === baselinePlace.id) {
        continue;
      }
      if (!isCanaryCoreCategory(alternative.place) || !isFiniteGeoPoint(alternative.place)) {
        continue;
      }
      if (!isUsableCanaryScore(alternative.preRouteScore)) {
        continue;
      }
      if (alternative.suggestedStartTime !== input.baseline.suggestedStartTime) {
        continue;
      }
      if (alternative.suggestedDurationMinutes !== input.baseline.suggestedDurationMinutes) {
        continue;
      }
      const distance = haversineMeters(baselinePlace, alternative.place);
      if (!Number.isFinite(distance) || distance > CANARY_CORE_COMPLETION_MAX_DISTANCE_METERS_V1) {
        continue;
      }
      if (alternative.preRouteScore - input.baseline.preRouteScore < CANARY_CORE_COMPLETION_SCORE_GAP_V1) {
        continue;
      }
      eligible.push(alternative);
    }
    if (eligible.length === 0) {
      return baselinePlace;
    }
    eligible.sort((left, right) => {
      if (left.preRouteScore !== right.preRouteScore) {
        return right.preRouteScore - left.preRouteScore;
      }
      return left.rerankIndex - right.rerankIndex;
    });
    return eligible[0]?.place ?? baselinePlace;
  } catch {
    return baselinePlace;
  }
}
