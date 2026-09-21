import type { Place } from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TripConstraintsV1,
} from '../../src/domain/trip/profile';
import {
  HEAVY_CORE_DAY_MINUTES_V1,
  HIGH_WALKING_BURDEN_V1,
  LONG_CORE_STAY_MINUTES_V1,
  MAX_FATIGUE_PENALTY_V1,
} from '../../src/domain/trip/itinerary-fatigue-v1';
import { derivePoiFeatureV1 } from './poi-feature-v1';

export interface SameDayFatigueCoreStopV1 {
  suggestedDurationMinutes?: number;
  place: Pick<Place, 'id' | 'category'>;
}

export interface SameDayFatigueInputV1 {
  candidate: Place;
  existingCoreStops: readonly SameDayFatigueCoreStopV1[];
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  planningPolicy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
}

export interface SameDayFatigueResultV1 {
  penalty: number;
}

function isLowWalkingContext(
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

function coreDurationMinutes(stops: readonly SameDayFatigueCoreStopV1[]): number[] {
  return stops
    .map((stop) => stop.suggestedDurationMinutes)
    .filter((minutes): minutes is number => typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0);
}

function readWalkingBurden(candidate: Place): number | undefined {
  try {
    const burden = derivePoiFeatureV1(candidate).walkingBurden;
    if (typeof burden !== 'number' || !Number.isFinite(burden) || burden < 0 || burden > 1) {
      return undefined;
    }
    return burden;
  } catch {
    return undefined;
  }
}

export function calculateSameDayFatiguePenaltyV1(
  input: SameDayFatigueInputV1,
): SameDayFatigueResultV1 {
  try {
    void input.planningPolicy;
    const burden = readWalkingBurden(input.candidate);
    if (burden === undefined) {
      return { penalty: 0 };
    }
    const highWalking = burden >= HIGH_WALKING_BURDEN_V1;
    const durations = coreDurationMinutes(input.existingCoreStops ?? []);
    const hasLongStay = durations.some((minutes) => minutes >= LONG_CORE_STAY_MINUTES_V1);
    const heavyDay = durations.reduce((sum, minutes) => sum + minutes, 0) >= HEAVY_CORE_DAY_MINUTES_V1;
    const lowWalking = isLowWalkingContext(input.partyContext, input.constraints);

    if (!lowWalking) {
      return {
        penalty: highWalking && (hasLongStay || heavyDay) ? 5 : 0,
      };
    }

    let penalty = 0;
    if (highWalking) {
      penalty += 8;
    }
    if (hasLongStay) {
      penalty += 5;
    }
    if (heavyDay) {
      penalty += 5;
    }
    return {
      penalty: Math.min(MAX_FATIGUE_PENALTY_V1, penalty),
    };
  } catch {
    return { penalty: 0 };
  }
}
