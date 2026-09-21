import type { TripPace } from '../domain/trip/types';
import {
  DEFAULT_CORE_AREA_DISTANCE_METERS,
  LOW_WALKING_CORE_AREA_DISTANCE_METERS,
  TRAVEL_INTEREST_KEYS,
  type PlanningPolicyV1,
  type PartyContextV1,
  type TravelInterestKey,
  type TravelProfileSignals,
  type TripConstraintsV1,
  type TripIntentV1,
  type TripPlanningContextV1,
  type UserTravelProfileV1,
} from '../domain/trip/profile';

const HIGH_SIGNAL = 0.6;

export interface PlanningPolicyInput {
  profile?: UserTravelProfileV1 | TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  tripPace?: TripPace;
}

function signalsOf(profile: PlanningPolicyInput['profile']): TravelProfileSignals {
  if (!profile) {
    return {};
  }
  if ('signals' in profile && profile.signals) {
    return profile.signals;
  }
  return profile as TravelProfileSignals;
}

function preferredFromProfile(signals: TravelProfileSignals): TravelInterestKey[] {
  const keys: TravelInterestKey[] = [];
  for (const key of TRAVEL_INTEREST_KEYS) {
    const signal = signals[key];
    if (signal && signal.value >= HIGH_SIGNAL) {
      keys.push(key);
    }
  }
  return keys;
}

export function buildPlanningPolicyV1(input: PlanningPolicyInput): PlanningPolicyV1 {
  const signals = signalsOf(input.profile);
  const excluded = [...(input.constraints?.excludedInterestKeys ?? [])];
  const preferred = [
    ...(input.tripIntent?.interestKeys ?? []),
    ...preferredFromProfile(signals),
  ].filter((key, index, list) => !excluded.includes(key) && list.indexOf(key) === index);

  const lowWalking = Boolean(
    input.constraints?.lowWalking
    || input.partyContext?.mobilityRequirement === 'low_walking'
    || input.partyContext?.partyType === 'parents'
    || input.partyContext?.hasElderly,
  );
  const profilePace = signals.pace;
  const tripPace = input.tripIntent?.pace
    ?? input.tripPace
    ?? (profilePace && profilePace.value < 0.4 ? 'relaxed' as const : undefined);
  const targetCorePlacesPerDay: 2 | 3 = (
    lowWalking || tripPace === 'relaxed'
  ) ? 2 : 3;

  const niche = signals.popular_vs_niche?.value ?? 0.5;
  const indoorOutdoor = signals.indoor_vs_outdoor?.value ?? 0.5;

  return {
    targetCorePlacesPerDay,
    maxCoreAreaDistanceMeters: lowWalking
      ? LOW_WALKING_CORE_AREA_DISTANCE_METERS
      : DEFAULT_CORE_AREA_DISTANCE_METERS,
    preferredInterestKeys: preferred,
    excludedInterestKeys: excluded,
    preferClassicLandmarks: niche <= 0.7,
    preferIndoor: indoorOutdoor < 0.4,
    preferOutdoor: indoorOutdoor > 0.6,
  };
}

export function planningPolicyPromptSummary(policy: PlanningPolicyV1): string {
  const parts = [
    `每天安排 ${policy.targetCorePlacesPerDay} 个核心地点`,
    `同一区域跨度尽量控制在 ${Math.round(policy.maxCoreAreaDistanceMeters / 1000)} 公里内`,
  ];
  if (policy.preferredInterestKeys.length > 0) {
    parts.push(`优先兴趣：${policy.preferredInterestKeys.join('、')}`);
  }
  if (policy.excludedInterestKeys.length > 0) {
    parts.push(`明确避开：${policy.excludedInterestKeys.join('、')}`);
  }
  if (policy.preferClassicLandmarks) {
    parts.push('保留城市高代表性地点');
  }
  if (policy.preferIndoor) {
    parts.push('可偏向室内场馆');
  }
  if (policy.preferOutdoor) {
    parts.push('可偏向户外场所');
  }
  return parts.join('。');
}

export function planningPolicyFromTripContext(input: {
  pace?: TripPace;
  planningContext?: TripPlanningContextV1;
}): PlanningPolicyV1 {
  return buildPlanningPolicyV1({
    tripIntent: input.planningContext?.tripIntent,
    partyContext: input.planningContext?.partyContext,
    constraints: input.planningContext?.constraints,
    tripPace: input.pace,
  });
}
