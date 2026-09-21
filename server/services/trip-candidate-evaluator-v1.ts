import type { Place } from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  TravelInterestKey,
  TravelProfileSignals,
  TripConstraintsV1,
} from '../../src/domain/trip/profile';
import {
  CANDIDATE_SCORE_WEIGHTS_V1,
  NEUTRAL_CANDIDATE_SCORE,
  RELIABLE_CATEGORY_EXCLUSIONS,
  type CandidateEvaluationV1,
  type CandidateHardConstraintReason,
  type CandidateHardConstraintResult,
  type CandidateMustVisitCoverageV1,
  type CandidateScoreBreakdownV1,
  type CandidateScoreResultV1,
  type CoreCandidateEvaluationInputV1,
} from '../../src/domain/trip/recommendation-scoring-v1';
import { derivePoiFeatureV1 } from './poi-feature-v1';
import { haversineMeters, isFiniteGeoPoint } from './trip-route-enricher';

const CORE_CATEGORIES = new Set<Place['category']>(['attraction', 'activity']);

export function clampCandidateScore(value: number): number {
  if (!Number.isFinite(value)) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function scoreRouteFitV1(routeDetourMinutes: number | undefined): number {
  if (typeof routeDetourMinutes !== 'number' || !Number.isFinite(routeDetourMinutes) || routeDetourMinutes < 0) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  // TODO(S2): relaxed / lowWalking may adjust these buckets once ranking is live.
  if (routeDetourMinutes <= 5) {
    return 100;
  }
  if (routeDetourMinutes <= 15) {
    return 80;
  }
  if (routeDetourMinutes <= 30) {
    return 50;
  }
  if (routeDetourMinutes <= 45) {
    return 20;
  }
  return 0;
}

function hasUsableIdentity(place: Place): boolean {
  return place.id.trim() !== ''
    && place.name.trim() !== ''
    && typeof place.category === 'string'
    && isFiniteGeoPoint(place);
}

function reliableExcludedInterest(
  place: Place,
  excluded: readonly TravelInterestKey[] | undefined,
): boolean {
  if (!excluded || excluded.length === 0) {
    return false;
  }
  const mapped = RELIABLE_CATEGORY_EXCLUSIONS[place.category];
  return mapped !== undefined && excluded.includes(mapped);
}

function nearestAnchorMeters(place: Place, anchors: readonly Place[] | undefined): number | undefined {
  if (!anchors || anchors.length === 0 || !isFiniteGeoPoint(place)) {
    return undefined;
  }
  const usable = anchors.filter((anchor) => isFiniteGeoPoint(anchor));
  if (usable.length === 0) {
    return undefined;
  }
  return Math.min(...usable.map((anchor) => haversineMeters(place, anchor)));
}

export function evaluateCoreCandidateConstraintsV1(
  input: CoreCandidateEvaluationInputV1,
): CandidateHardConstraintResult {
  const reasons: CandidateHardConstraintReason[] = [];
  const { place } = input;
  if (input.usedPlaceIds?.has(place.id)) {
    reasons.push('DUPLICATE_PLACE');
  }
  if (!isFiniteGeoPoint(place)) {
    reasons.push('INVALID_COORDINATES');
  }
  if (!CORE_CATEGORIES.has(place.category)) {
    reasons.push('UNSUPPORTED_CATEGORY');
  }
  const excluded = input.constraints?.excludedInterestKeys ?? input.policy?.excludedInterestKeys;
  if (reliableExcludedInterest(place, excluded)) {
    reasons.push('EXCLUDED_INTEREST');
  }
  const maxDistance = input.policy?.maxCoreAreaDistanceMeters;
  const nearest = nearestAnchorMeters(place, input.anchors);
  if (
    typeof maxDistance === 'number'
    && Number.isFinite(maxDistance)
    && nearest !== undefined
    && nearest > maxDistance
  ) {
    reasons.push('OUTSIDE_MAX_CORE_DISTANCE');
  }
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function explicitInterestSignals(signals: TravelProfileSignals | undefined): Partial<Record<TravelInterestKey, number>> {
  const next: Partial<Record<TravelInterestKey, number>> = {};
  if (!signals) {
    return next;
  }
  for (const [key, signal] of Object.entries(signals)) {
    if (!signal || signal.source !== 'explicit') {
      continue;
    }
    next[key as TravelInterestKey] = signal.value;
  }
  return next;
}

function scorePreferenceMatch(input: CoreCandidateEvaluationInputV1): number {
  const features = derivePoiFeatureV1(input.place);
  const explicit = explicitInterestSignals(input.profileSignals);
  const usable = features.interestKeys
    .map((key) => explicit[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (usable.length === 0) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return clampCandidateScore(average * 100);
}

function scoreTripIntentMatch(input: CoreCandidateEvaluationInputV1): number {
  const keys = input.tripIntent?.interestKeys ?? [];
  if (keys.length === 0) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  const features = new Set(derivePoiFeatureV1(input.place).interestKeys);
  const matched = keys.filter((key) => features.has(key)).length;
  if (matched === 0) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  return clampCandidateScore(50 + (50 * matched) / keys.length);
}

function isLowWalkingParty(
  party: PartyContextV1 | undefined,
  constraints: TripConstraintsV1 | undefined,
): boolean {
  return Boolean(
    constraints?.lowWalking
    || party?.mobilityRequirement === 'low_walking'
    || party?.partyType === 'parents'
    || party?.hasElderly,
  );
}

function scorePartyFit(input: CoreCandidateEvaluationInputV1): number {
  if (!isLowWalkingParty(input.partyContext, input.constraints)) {
    return NEUTRAL_CANDIDATE_SCORE;
  }
  const burden = derivePoiFeatureV1(input.place).walkingBurden;
  return clampCandidateScore((1 - burden) * 100);
}

function scoreDataConfidence(place: Place): number {
  return hasUsableIdentity(place) ? 100 : 0;
}

export function scoreCoreCandidateV1(input: CoreCandidateEvaluationInputV1): CandidateScoreResultV1 {
  const breakdown: CandidateScoreBreakdownV1 = {
    preferenceMatch: scorePreferenceMatch(input),
    tripIntentMatch: scoreTripIntentMatch(input),
    partyFit: scorePartyFit(input),
    routeFit: scoreRouteFitV1(input.routeDetourMinutes),
    dataConfidence: scoreDataConfidence(input.place),
  };
  const total = clampCandidateScore(
    breakdown.preferenceMatch * CANDIDATE_SCORE_WEIGHTS_V1.preferenceMatch
    + breakdown.tripIntentMatch * CANDIDATE_SCORE_WEIGHTS_V1.tripIntentMatch
    + breakdown.partyFit * CANDIDATE_SCORE_WEIGHTS_V1.partyFit
    + breakdown.routeFit * CANDIDATE_SCORE_WEIGHTS_V1.routeFit
    + breakdown.dataConfidence * CANDIDATE_SCORE_WEIGHTS_V1.dataConfidence,
  );
  return { total, breakdown };
}

export function evaluateCoreCandidateV1(input: CoreCandidateEvaluationInputV1): CandidateEvaluationV1 {
  const constraints = evaluateCoreCandidateConstraintsV1(input);
  if (!constraints.eligible) {
    return { constraints };
  }
  return {
    constraints,
    score: scoreCoreCandidateV1(input),
  };
}

export function diagnoseMustVisitCoverageV1(input: {
  mustVisit?: readonly string[];
  selectedNames?: readonly string[];
}): CandidateMustVisitCoverageV1 {
  const requested = [...new Set((input.mustVisit ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== ''))];
  const selected = new Set((input.selectedNames ?? []).map((item) => item.trim()));
  return {
    requested,
    matched: requested.filter((item) => selected.has(item)),
  };
}

export function shadowEvaluateCoreCandidateV1(input: CoreCandidateEvaluationInputV1): void {
  try {
    evaluateCoreCandidateV1(input);
  } catch {
    // Shadow Mode must never affect generation, logging, or HTTP.
  }
}
