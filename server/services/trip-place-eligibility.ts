import type { Place, TripPlaceType } from '../../src/domain/trip/types';
import type { TripPlanPlaceCategory, TripPlaceSuggestion } from './trip-plan-generator';

const PLACE_NAME_PUNCT = /[\s\u3000，。！？、；：""''“”‘’《》【】（）()[\].,!?;:·\-—_/\\]+/g;

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(PLACE_NAME_PUNCT, '').toLowerCase();
}

export const TRAVEL_INELIGIBLE_NAME_TERMS = [
  '游客中心',
  '停车场',
  '加油站',
  '充电站',
  '服务区',
  '售票处',
  '公交站',
  '地铁站',
  '轻轨站',
  '火车站',
  '高铁站',
  '汽车站',
  '警务室',
  '管理处',
  '候车',
  '接驳',
  '换乘',
  '线路',
  '入口',
  '出口',
  '厕所',
  '站点',
  '码头',
] as const;

export const MAIN_SUBSTITUTE_FORBIDDEN_TERMS = [
  '游客中心',
  '售票处',
  '凉亭',
  '码头',
  '入口',
  '出口',
  '亭',
  '桥',
  '门',
] as const;

export type TripPlaceEligibilityKind =
  | 'MAIN'
  | 'EXPLICIT_SUB_PLACE'
  | 'DINING'
  | 'COFFEE'
  | 'SHOPPING'
  | 'HOTEL'
  | 'INELIGIBLE';

export type TripPlaceEligibilityReason =
  | 'ELIGIBLE'
  | 'TRANSIT_OR_SERVICE'
  | 'CATEGORY_MISMATCH';

export interface TripPlaceEligibilityDecision {
  eligible: boolean;
  kind: TripPlaceEligibilityKind;
  reason: TripPlaceEligibilityReason;
}

const SIGHTSEEING_CATEGORIES: ReadonlySet<TripPlaceType> = new Set(['attraction', 'activity']);

export function allowedPlaceCategoriesForSuggestion(
  suggestionCategory: TripPlanPlaceCategory,
): ReadonlySet<TripPlaceType> {
  if (suggestionCategory === 'food') {
    return new Set(['restaurant']);
  }
  if (suggestionCategory === 'coffee') {
    return new Set(['cafe']);
  }
  if (suggestionCategory === 'shopping') {
    return new Set(['shopping']);
  }
  if (suggestionCategory === 'hotel') {
    return new Set();
  }
  return SIGHTSEEING_CATEGORIES;
}

function suggestionText(suggestion: TripPlaceSuggestion): string {
  return `${normalizeText(suggestion.query)}${normalizeText(suggestion.name)}`;
}

function nameHasTerm(normalizedName: string, term: string): boolean {
  const needle = normalizeText(term);
  return needle !== '' && normalizedName.includes(needle);
}

function queryAllowsTerm(suggestion: TripPlaceSuggestion, term: string): boolean {
  return suggestionText(suggestion).includes(normalizeText(term));
}

export function isTransitOrServicePlace(place: Place, suggestion: TripPlaceSuggestion): boolean {
  if (place.category === 'transport') {
    return true;
  }
  const name = normalizeText(place.name);
  for (const term of TRAVEL_INELIGIBLE_NAME_TERMS) {
    if (!nameHasTerm(name, term)) {
      continue;
    }
    if (term === '码头' && queryAllowsTerm(suggestion, '码头')) {
      continue;
    }
    return true;
  }
  return false;
}

export function isForbiddenMainSubstitute(place: Place): boolean {
  const name = normalizeText(place.name);
  return MAIN_SUBSTITUTE_FORBIDDEN_TERMS.some((term) => nameHasTerm(name, term));
}

function commercialKind(category: TripPlaceType): Exclude<TripPlaceEligibilityKind, 'MAIN' | 'EXPLICIT_SUB_PLACE' | 'INELIGIBLE'> | undefined {
  if (category === 'restaurant') {
    return 'DINING';
  }
  if (category === 'cafe') {
    return 'COFFEE';
  }
  if (category === 'shopping') {
    return 'SHOPPING';
  }
  if (category === 'hotel') {
    return 'HOTEL';
  }
  return undefined;
}

export function evaluateTripPlaceEligibility(
  place: Place,
  suggestion: TripPlaceSuggestion,
): TripPlaceEligibilityDecision {
  if (place.category === 'hotel' || suggestion.category === 'hotel') {
    return { eligible: false, kind: 'INELIGIBLE', reason: 'CATEGORY_MISMATCH' };
  }
  if (isTransitOrServicePlace(place, suggestion)) {
    return { eligible: false, kind: 'INELIGIBLE', reason: 'TRANSIT_OR_SERVICE' };
  }
  const allowed = allowedPlaceCategoriesForSuggestion(suggestion.category);
  if (!allowed.has(place.category)) {
    return { eligible: false, kind: 'INELIGIBLE', reason: 'CATEGORY_MISMATCH' };
  }
  const commercial = commercialKind(place.category);
  if (commercial) {
    return { eligible: true, kind: commercial, reason: 'ELIGIBLE' };
  }
  const explicitSub = MAIN_SUBSTITUTE_FORBIDDEN_TERMS.some((term) => queryAllowsTerm(suggestion, term));
  return {
    eligible: true,
    kind: explicitSub ? 'EXPLICIT_SUB_PLACE' : 'MAIN',
    reason: 'ELIGIBLE',
  };
}

export function filterEligibleTripPlaces(
  places: readonly Place[],
  suggestion: TripPlaceSuggestion,
): Place[] {
  return places.filter((place) => evaluateTripPlaceEligibility(place, suggestion).eligible);
}
