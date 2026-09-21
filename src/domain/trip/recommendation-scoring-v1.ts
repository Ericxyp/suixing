import type { Place } from './types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TravelInterestKey,
  TravelProfileSignals,
  TripConstraintsV1,
  TripIntentV1,
} from './profile';

export const CANDIDATE_HARD_CONSTRAINT_REASONS = [
  'DUPLICATE_PLACE',
  'EXCLUDED_INTEREST',
  'INVALID_COORDINATES',
  'UNSUPPORTED_CATEGORY',
  'OUTSIDE_MAX_CORE_DISTANCE',
] as const;

export type CandidateHardConstraintReason = typeof CANDIDATE_HARD_CONSTRAINT_REASONS[number];

export interface CandidateHardConstraintResult {
  eligible: boolean;
  reasons: CandidateHardConstraintReason[];
}

export interface CandidateScoreBreakdownV1 {
  preferenceMatch: number;
  tripIntentMatch: number;
  partyFit: number;
  routeFit: number;
  dataConfidence: number;
}

export interface CandidateScoreResultV1 {
  total: number;
  breakdown: CandidateScoreBreakdownV1;
}

export interface CandidateEvaluationV1 {
  constraints: CandidateHardConstraintResult;
  score?: CandidateScoreResultV1;
}

export interface CandidateMustVisitCoverageV1 {
  requested: string[];
  matched: string[];
}

export interface CoreCandidateEvaluationInputV1 {
  place: Place;
  usedPlaceIds?: ReadonlySet<string>;
  anchors?: readonly Place[];
  policy?: PlanningPolicyV1;
  profileSignals?: TravelProfileSignals;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  routeDetourMinutes?: number;
}

export const CANDIDATE_SCORE_WEIGHTS_V1 = {
  preferenceMatch: 0.3,
  tripIntentMatch: 0.3,
  partyFit: 0.2,
  routeFit: 0.15,
  dataConfidence: 0.05,
} as const;

export const NEUTRAL_CANDIDATE_SCORE = 50;

export const RELIABLE_CATEGORY_EXCLUSIONS: Partial<Record<Place['category'], TravelInterestKey>> = {
  shopping: 'shopping',
  restaurant: 'food',
  cafe: 'coffee',
};
