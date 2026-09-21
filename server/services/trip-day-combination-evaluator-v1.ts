import type {
  Place,
  Trip,
  TripDay,
  TripPlace,
  TripRoute,
} from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TravelProfileSignals,
  TripConstraintsV1,
  TripIntentV1,
} from '../../src/domain/trip/profile';
import {
  DAY_COMBINATION_SCORE_WEIGHTS_V1,
  type DayCombinationScoreBreakdownV1,
  type DayCombinationScoreV1,
} from '../../src/domain/trip/day-combination-score-v1';
import { HIGH_WALKING_BURDEN_V1 } from '../../src/domain/trip/itinerary-fatigue-v1';
import { deriveCoreExperienceGroupV1 } from './trip-itinerary-diversity-v1';
import { derivePoiFeatureV1 } from './poi-feature-v1';
import { isCoreTripPlace } from './trip-day-density-planner';
import { clampCandidateScore, scoreCoreCandidateV1 } from './trip-candidate-evaluator-v1';

export interface DayCombinationEvaluationInputV1 {
  day: TripDay;
  places?: readonly Place[];
  routes?: readonly TripRoute[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
}

function isLowWalking(
  partyContext?: PartyContextV1,
  constraints?: TripConstraintsV1,
): boolean {
  return Boolean(
    constraints?.lowWalking
    || partyContext?.mobilityRequirement === 'low_walking'
    || partyContext?.partyType === 'parents'
    || partyContext?.hasElderly,
  );
}

function catalogPlace(tripPlace: TripPlace, places: readonly Place[] | undefined): Place | undefined {
  return (places ?? []).find((place) => place.id === tripPlace.placeId);
}

function scoreCoreCoverage(cores: readonly TripPlace[], target: 2 | 3): number {
  if (cores.length <= 0) {
    return 0;
  }
  return clampCandidateScore((cores.length / target) * 100);
}

function scoreCandidateQuality(
  cores: readonly TripPlace[],
  input: DayCombinationEvaluationInputV1,
): number {
  if (cores.length === 0) {
    return 50;
  }
  const totals: number[] = [];
  for (const tripPlace of cores) {
    const place = catalogPlace(tripPlace, input.places);
    if (!place) {
      continue;
    }
    try {
      const score = scoreCoreCandidateV1({
        place,
        profileSignals: input.profileSignals,
        tripIntent: input.tripIntent,
        partyContext: input.partyContext,
        constraints: input.constraints,
      });
      if (typeof score.total === 'number' && Number.isFinite(score.total)) {
        totals.push(score.total);
      }
    } catch {
      // Missing score context stays out of the average rather than failing the day.
    }
  }
  if (totals.length === 0) {
    return 50;
  }
  return clampCandidateScore(totals.reduce((sum, value) => sum + value, 0) / totals.length);
}

function scoreDiversity(cores: readonly TripPlace[], places: readonly Place[] | undefined): number {
  if (cores.length === 0) {
    return 50;
  }
  const known = new Set<string>();
  for (const tripPlace of cores) {
    const place = catalogPlace(tripPlace, places);
    if (!place) {
      continue;
    }
    const group = deriveCoreExperienceGroupV1(place);
    if (group !== 'unknown') {
      known.add(group);
    }
  }
  if (known.size <= 1) {
    return 50;
  }
  if (cores.length === 2) {
    return 100;
  }
  if (known.size >= 3) {
    return 100;
  }
  return 75;
}

function readWalkingBurden(place: Place): number | undefined {
  try {
    const burden = derivePoiFeatureV1(place).walkingBurden;
    if (typeof burden !== 'number' || !Number.isFinite(burden)) {
      return undefined;
    }
    return burden;
  } catch {
    return undefined;
  }
}

function scoreFatigueRhythm(
  cores: readonly TripPlace[],
  input: DayCombinationEvaluationInputV1,
): number {
  const durations = cores
    .map((place) => place.durationMinutes)
    .filter((minutes): minutes is number => typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0);
  const burdens = cores.flatMap((tripPlace) => {
    const place = catalogPlace(tripPlace, input.places);
    if (!place) {
      return [];
    }
    const burden = readWalkingBurden(place);
    return burden === undefined ? [] : [burden];
  });
  if (durations.length === 0 && burdens.length === 0) {
    return 50;
  }
  if (!isLowWalking(input.partyContext, input.constraints)) {
    return 80;
  }
  const highWalking = burdens.filter((burden) => burden >= HIGH_WALKING_BURDEN_V1).length;
  const totalDuration = durations.reduce((sum, minutes) => sum + minutes, 0);
  if (highWalking >= 2 && totalDuration >= 240) {
    return 30;
  }
  if (highWalking >= 2 || totalDuration >= 240) {
    return 45;
  }
  if (highWalking >= 1 || totalDuration >= 150) {
    return 60;
  }
  return 75;
}

function scoreRouteEfficiency(day: TripDay, routes: readonly TripRoute[] | undefined): number {
  const dayRoutes = (routes ?? []).filter((route) => route.dayId === day.id);
  const minutes = dayRoutes
    .map((route) => route.transport?.durationMinutes)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (minutes.length === 0) {
    return 50;
  }
  const total = minutes.reduce((sum, value) => sum + value, 0);
  if (total <= 45) {
    return 100;
  }
  if (total <= 90) {
    return 80;
  }
  if (total <= 150) {
    return 55;
  }
  return 25;
}

export function evaluateDayCombinationV1(
  input: DayCombinationEvaluationInputV1,
): DayCombinationScoreV1 {
  const cores = (input.day.places ?? []).filter((place) => isCoreTripPlace(place));
  const target = input.policy?.targetCorePlacesPerDay === 2 ? 2 : 3;
  const breakdown: DayCombinationScoreBreakdownV1 = {
    coreCoverage: scoreCoreCoverage(cores, target),
    candidateQuality: scoreCandidateQuality(cores, input),
    diversity: scoreDiversity(cores, input.places),
    fatigueRhythm: scoreFatigueRhythm(cores, input),
    routeEfficiency: scoreRouteEfficiency(input.day, input.routes),
  };
  const total = clampCandidateScore(
    breakdown.coreCoverage * DAY_COMBINATION_SCORE_WEIGHTS_V1.coreCoverage
    + breakdown.candidateQuality * DAY_COMBINATION_SCORE_WEIGHTS_V1.candidateQuality
    + breakdown.diversity * DAY_COMBINATION_SCORE_WEIGHTS_V1.diversity
    + breakdown.fatigueRhythm * DAY_COMBINATION_SCORE_WEIGHTS_V1.fatigueRhythm
    + breakdown.routeEfficiency * DAY_COMBINATION_SCORE_WEIGHTS_V1.routeEfficiency,
  );
  return { total, breakdown };
}

export function shadowEvaluateGeneratedDayCombinationsV1(input: {
  trip: Trip;
  places?: readonly Place[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  evaluate?: (input: DayCombinationEvaluationInputV1) => DayCombinationScoreV1;
}): void {
  try {
    const evaluate = input.evaluate ?? evaluateDayCombinationV1;
    for (const day of input.trip.days) {
      evaluate({
        day,
        places: input.places,
        routes: input.trip.routes,
        policy: input.policy,
        profileSignals: input.profileSignals,
        tripIntent: input.tripIntent,
        partyContext: input.partyContext,
        constraints: input.constraints,
      });
    }
  } catch {
    // Shadow Mode must never affect generation, logging, or HTTP.
  }
}
