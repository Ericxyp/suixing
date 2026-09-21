import type { Place } from '../../src/domain/trip/types';
import { filterEligibleTripPlaces } from './trip-place-eligibility';
import type { PlaceSearchService } from './trip-place-resolver';
import type { TripPlanPlaceCategory } from './trip-plan-generator';
import { normalizeTripChangePlaceName } from './trip-change-intent-extractor';
import {
  candidateRelation,
  publicCategoryLabel,
  type TripChangePublicCandidate,
} from './trip-change-intent-refine';

export const CHANGE_OPTIONS_LIMIT = 5;
export const CHANGE_OPTIONS_SEARCH_LIMIT = 10;

export async function searchNearbyChangeOptions(input: {
  city: string;
  sourceName: string;
  nextName?: string;
  category: TripPlanPlaceCategory;
  query: string;
  excludePlaceNames?: readonly string[];
  excludePlaceIds?: readonly string[];
  placeSearch: PlaceSearchService;
}): Promise<TripChangePublicCandidate[]> {
  const searched = await input.placeSearch.search({
    query: `${input.sourceName}附近 ${input.query}`,
    city: input.city,
    limit: CHANGE_OPTIONS_SEARCH_LIMIT,
  });
  const suggestion = {
    name: input.query,
    query: `${input.sourceName}附近 ${input.query}`,
    category: input.category,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '行程修改候选地点。',
  };
  const excludedNames = new Set(
    (input.excludePlaceNames ?? []).map((name) => normalizeTripChangePlaceName(name)),
  );
  const excludedIds = new Set(input.excludePlaceIds ?? []);
  const eligible = filterEligibleTripPlaces(searched, suggestion)
    .filter((place) => {
      const normalized = normalizeTripChangePlaceName(place.name);
      return !excludedIds.has(place.id) && !excludedNames.has(normalized);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return eligible.slice(0, CHANGE_OPTIONS_LIMIT).map((place) => toCandidate(place, input.sourceName, input.nextName));
}

function toCandidate(
  place: Place,
  sourceName: string,
  nextName?: string,
): TripChangePublicCandidate {
  return {
    placeId: place.id,
    name: place.name,
    categoryLabel: publicCategoryLabel(place.category),
    relation: candidateRelation(sourceName, nextName),
  };
}
