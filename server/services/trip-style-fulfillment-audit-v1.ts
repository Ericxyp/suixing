import type {
  Place,
  Trip,
  TripDay,
  TripPlace,
} from '../../src/domain/trip/types';
import type {
  PartyContextV1,
  PlanningPolicyV1,
  TravelInterestKey,
  TripConstraintsV1,
  TripIntentV1,
  TripPlanningContextV1,
} from '../../src/domain/trip/profile';
import {
  STYLE_FULFILLMENT_AUDIT_ITEMS_V1,
  type StyleFulfillmentAuditItemKeyV1,
  type StyleFulfillmentAuditV1,
  type StyleFulfillmentItemResultV1,
  type StyleFulfillmentOverallStatusV1,
} from '../../src/domain/trip/style-fulfillment-audit-v1';
import { RELIABLE_CATEGORY_EXCLUSIONS } from '../../src/domain/trip/recommendation-scoring-v1';
import { isCoreTripPlace, isMealTripPlace } from './trip-day-density-planner';
import { derivePoiFeatureV1 } from './poi-feature-v1';

/** Interest keys that are fulfilled by meal arrangements, not core places. */
const MEAL_INTEREST_KEYS = new Set<TravelInterestKey>(['food', 'coffee']);

export interface StyleFulfillmentAuditInputV1 {
  trip: Trip;
  places?: readonly Place[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  planningContext?: TripPlanningContextV1;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
}

function item(
  status: StyleFulfillmentItemResultV1['status'],
  reason?: string,
): StyleFulfillmentItemResultV1 {
  return reason ? { status, reason } : { status };
}

function notEvaluable(reason: string): StyleFulfillmentItemResultV1 {
  return item('not_evaluable', reason);
}

function resolveIntent(input: StyleFulfillmentAuditInputV1): TripIntentV1 | undefined {
  return input.tripIntent ?? input.planningContext?.tripIntent ?? input.trip.planningContext?.tripIntent;
}

function resolveParty(input: StyleFulfillmentAuditInputV1): PartyContextV1 | undefined {
  return input.partyContext ?? input.planningContext?.partyContext ?? input.trip.planningContext?.partyContext;
}

function resolveConstraints(input: StyleFulfillmentAuditInputV1): TripConstraintsV1 | undefined {
  return input.constraints ?? input.planningContext?.constraints ?? input.trip.planningContext?.constraints;
}

function isLowWalkingContext(
  party?: PartyContextV1,
  constraints?: TripConstraintsV1,
): boolean {
  return Boolean(
    constraints?.lowWalking
    || party?.mobilityRequirement === 'low_walking'
    || party?.partyType === 'parents'
    || party?.hasElderly,
  );
}

function catalogPlace(tripPlace: TripPlace, places: readonly Place[] | undefined): Place | undefined {
  return (places ?? []).find((place) => place.id === tripPlace.placeId);
}

function activeDays(trip: Trip): TripDay[] {
  return (trip.days ?? []).filter((day) => (day.places ?? []).length > 0);
}

function auditCorePlaceCount(
  days: readonly TripDay[],
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>,
): StyleFulfillmentItemResultV1 {
  const target = policy?.targetCorePlacesPerDay;
  if (target !== 2 && target !== 3) {
    return notEvaluable('missing_target_core_places');
  }
  if (days.length === 0) {
    return notEvaluable('no_active_days');
  }
  for (const day of days) {
    const cores = day.places.filter((place) => isCoreTripPlace(place));
    if (cores.length < target) {
      return item('not_met', `day_${day.dayNumber}_cores_${cores.length}_lt_${target}`);
    }
  }
  return item('met', `all_days_reach_${target}`);
}

function auditExcludedInterest(
  days: readonly TripDay[],
  places: readonly Place[] | undefined,
  constraints?: TripConstraintsV1,
): StyleFulfillmentItemResultV1 {
  const excluded = constraints?.excludedInterestKeys ?? [];
  if (excluded.length === 0) {
    return notEvaluable('no_excluded_interests');
  }
  const reliableExcluded = new Set(
    Object.entries(RELIABLE_CATEGORY_EXCLUSIONS)
      .filter(([, interest]) => interest !== undefined && excluded.includes(interest))
      .map(([category]) => category as Place['category']),
  );
  if (reliableExcluded.size === 0) {
    return notEvaluable('no_reliable_category_mapping');
  }
  for (const day of days) {
    for (const tripPlace of day.places.filter((place) => isCoreTripPlace(place))) {
      const place = catalogPlace(tripPlace, places);
      const category = place?.category ?? tripPlace.type;
      if (reliableExcluded.has(category)) {
        return item('not_met', `core_${category}_excluded`);
      }
    }
  }
  return item('met', 'no_excluded_core_categories');
}

function auditLowWalkingPolicy(
  days: readonly TripDay[],
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>,
  party?: PartyContextV1,
  constraints?: TripConstraintsV1,
): StyleFulfillmentItemResultV1 {
  if (!isLowWalkingContext(party, constraints)) {
    return notEvaluable('not_low_walking_context');
  }
  const target = policy?.targetCorePlacesPerDay;
  if (target !== 2 && target !== 3) {
    return notEvaluable('missing_target_core_places');
  }
  if (days.length === 0) {
    return notEvaluable('no_active_days');
  }
  for (const day of days) {
    const cores = day.places.filter((place) => isCoreTripPlace(place));
    if (cores.length < target) {
      return item('not_met', `day_${day.dayNumber}_cores_${cores.length}_lt_${target}`);
    }
  }
  return item('met', `low_walking_cores_${target}`);
}

function coreIntentKeys(intent?: TripIntentV1): TravelInterestKey[] {
  return (intent?.interestKeys ?? []).filter((key) => !MEAL_INTEREST_KEYS.has(key));
}

function auditIntentCoverage(
  days: readonly TripDay[],
  places: readonly Place[] | undefined,
  intent?: TripIntentV1,
): StyleFulfillmentItemResultV1 {
  const keys = coreIntentKeys(intent);
  if (keys.length === 0) {
    return notEvaluable('no_core_intent_keys');
  }
  const cores = days.flatMap((day) => day.places.filter((place) => isCoreTripPlace(place)));
  if (cores.length === 0) {
    return notEvaluable('no_core_places');
  }
  let evaluableCores = 0;
  for (const tripPlace of cores) {
    const place = catalogPlace(tripPlace, places);
    if (!place) {
      continue;
    }
    try {
      const feature = derivePoiFeatureV1(place);
      if (!feature.interestKeys.length) {
        continue;
      }
      evaluableCores += 1;
      if (feature.interestKeys.some((key) => keys.includes(key))) {
        return item('met', `matched_${place.category}`);
      }
    } catch {
      // Unknown category or feature failure stays non-evaluable for that place.
    }
  }
  if (evaluableCores === 0) {
    return notEvaluable('no_recognizable_poi_features');
  }
  return item('not_met', 'no_intent_match_among_cores');
}

function dayHasMealArrangement(day: TripDay, places: readonly Place[] | undefined): boolean | undefined {
  const items = day.scheduleItems;
  if (!items) {
    return undefined;
  }
  for (const entry of items) {
    if (entry.kind === 'meal_slot') {
      return true;
    }
    if (entry.kind === 'meal_place' || entry.kind === 'meal') {
      const tripPlace = day.places.find((place) => place.id === entry.tripPlaceId);
      if (!tripPlace) {
        continue;
      }
      const place = catalogPlace(tripPlace, places);
      const type = place?.category ?? tripPlace.type;
      if (type === 'restaurant' || type === 'cafe' || isMealTripPlace(tripPlace)) {
        return true;
      }
    }
  }
  return false;
}

function auditMealArrangement(
  days: readonly TripDay[],
  places: readonly Place[] | undefined,
): StyleFulfillmentItemResultV1 {
  if (days.length === 0) {
    return notEvaluable('no_active_days');
  }
  let evaluated = 0;
  for (const day of days) {
    const result = dayHasMealArrangement(day, places);
    if (result === undefined) {
      continue;
    }
    evaluated += 1;
    if (!result) {
      return item('not_met', `day_${day.dayNumber}_missing_meal`);
    }
  }
  if (evaluated === 0) {
    return notEvaluable('no_schedule_items');
  }
  return item('met', 'all_days_have_meal_arrangement');
}

function overallOf(
  items: Record<StyleFulfillmentAuditItemKeyV1, StyleFulfillmentItemResultV1>,
): StyleFulfillmentOverallStatusV1 {
  const statuses = STYLE_FULFILLMENT_AUDIT_ITEMS_V1.map((key) => items[key].status);
  if (statuses.every((status) => status === 'not_evaluable')) {
    return 'not_evaluable';
  }
  if (statuses.some((status) => status === 'not_met')) {
    return 'partially_met';
  }
  return 'met';
}

export function evaluateStyleFulfillmentAuditV1(
  input: StyleFulfillmentAuditInputV1,
): StyleFulfillmentAuditV1 {
  const days = activeDays(input.trip);
  const intent = resolveIntent(input);
  const party = resolveParty(input);
  const constraints = resolveConstraints(input);
  const items: Record<StyleFulfillmentAuditItemKeyV1, StyleFulfillmentItemResultV1> = {
    corePlaceCount: auditCorePlaceCount(days, input.policy),
    excludedInterest: auditExcludedInterest(days, input.places, constraints),
    lowWalkingPolicy: auditLowWalkingPolicy(days, input.policy, party, constraints),
    intentCoverage: auditIntentCoverage(days, input.places, intent),
    mealArrangement: auditMealArrangement(days, input.places),
  };
  return {
    overall: overallOf(items),
    items,
  };
}

export function shadowEvaluateGeneratedTripStyleFulfillmentV1(input: {
  trip: Trip;
  places?: readonly Place[];
  policy?: Pick<PlanningPolicyV1, 'targetCorePlacesPerDay'>;
  planningContext?: TripPlanningContextV1;
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
  evaluate?: (input: StyleFulfillmentAuditInputV1) => StyleFulfillmentAuditV1;
}): void {
  try {
    const evaluate = input.evaluate ?? evaluateStyleFulfillmentAuditV1;
    evaluate({
      trip: input.trip,
      places: input.places,
      policy: input.policy,
      planningContext: input.planningContext ?? input.trip.planningContext,
      tripIntent: input.tripIntent,
      partyContext: input.partyContext,
      constraints: input.constraints,
    });
  } catch {
    // Shadow Mode must never affect generation, logging, or HTTP.
  }
}
