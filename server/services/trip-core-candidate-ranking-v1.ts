import type { Place } from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TravelProfileSignals,
  TripConstraintsV1,
  TripIntentV1,
} from '../../src/domain/trip/profile';
import type {
  CandidateEvaluationV1,
  CoreCandidateEvaluationInputV1,
} from '../../src/domain/trip/recommendation-scoring-v1';
import { evaluateCoreCandidateV1 } from './trip-candidate-evaluator-v1';
import { calculateSameDayDiversityPenaltyV1 } from './trip-itinerary-diversity-v1';
import {
  calculateSameDayFatiguePenaltyV1,
  type SameDayFatigueCoreStopV1,
} from './trip-itinerary-fatigue-v1';
import {
  calculateCrossDayDiversityPenaltyV1,
  type CrossDayDiversityCoreStopV1,
} from './trip-cross-day-diversity-v1';

export const CORE_CANDIDATE_SCORE_GAP_V1 = 8;

export interface CoreCandidateRankingContextV1 {
  usedPlaceIds?: ReadonlySet<string>;
  anchors?: readonly Place[];
  policy?: PlanningPolicyV1;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  routeDetourMinutes?: number;
  existingCoreStops?: readonly Place[];
  existingResolvedCores?: readonly SameDayFatigueCoreStopV1[];
  previousDayCoreStops?: readonly CrossDayDiversityCoreStopV1[];
  queryText?: string;
}

export type CoreCandidateEvaluateFnV1 = (
  input: CoreCandidateEvaluationInputV1,
) => CandidateEvaluationV1;

function isUsableTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function clampPenalty(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function safeDiversityPenalty(place: Place, context: CoreCandidateRankingContextV1): number {
  try {
    return clampPenalty(calculateSameDayDiversityPenaltyV1({
      candidate: place,
      existingCoreStops: context.existingCoreStops,
      queryText: context.queryText,
    }));
  } catch {
    return 0;
  }
}

function safeFatiguePenalty(place: Place, context: CoreCandidateRankingContextV1): number {
  try {
    const result = calculateSameDayFatiguePenaltyV1({
      candidate: place,
      existingCoreStops: context.existingResolvedCores ?? [],
      partyContext: context.partyContext,
      constraints: context.constraints,
      planningPolicy: context.policy
        ? { targetCorePlacesPerDay: context.policy.targetCorePlacesPerDay }
        : undefined,
    });
    return Math.min(20, clampPenalty(result.penalty));
  } catch {
    return 0;
  }
}

function safeCrossDayDiversityPenalty(place: Place, context: CoreCandidateRankingContextV1): number {
  try {
    if (!context.previousDayCoreStops) {
      return 0;
    }
    const result = calculateCrossDayDiversityPenaltyV1({
      candidate: place,
      completedPreviousDayCoreStops: context.previousDayCoreStops,
      queryText: context.queryText,
    });
    return Math.min(14, clampPenalty(result.penalty));
  } catch {
    return 0;
  }
}

export function rerankCoreCompletionCandidatesV1(
  legacyRanked: readonly Place[],
  context: CoreCandidateRankingContextV1,
  evaluate: CoreCandidateEvaluateFnV1 = evaluateCoreCandidateV1,
): Place[] {
  const baseline = [...legacyRanked];
  if (baseline.length <= 1) {
    return baseline;
  }
  try {
    const scored: Array<{ place: Place; index: number; total: number }> = [];
    for (const [index, place] of baseline.entries()) {
      const evaluation = evaluate({
        place,
        usedPlaceIds: context.usedPlaceIds,
        anchors: context.anchors,
        policy: context.policy,
        profileSignals: context.profileSignals,
        tripIntent: context.tripIntent,
        partyContext: context.partyContext,
        constraints: context.constraints,
        routeDetourMinutes: context.routeDetourMinutes,
      });
      const total = evaluation.score?.total;
      if (!evaluation.constraints.eligible || !isUsableTotal(total)) {
        return baseline;
      }
      const adjusted = Math.min(
        100,
        Math.max(
          0,
          total
            - safeDiversityPenalty(place, context)
            - safeFatiguePenalty(place, context)
            - safeCrossDayDiversityPenalty(place, context),
        ),
      );
      scored.push({ place, index, total: adjusted });
    }
    return scored
      .sort((left, right) => {
        if (Math.abs(left.total - right.total) < CORE_CANDIDATE_SCORE_GAP_V1) {
          return left.index - right.index;
        }
        return right.total - left.total;
      })
      .map((item) => item.place);
  } catch {
    return baseline;
  }
}
