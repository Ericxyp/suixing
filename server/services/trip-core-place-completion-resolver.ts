import type { Place, TripPace } from '../../src/domain/trip/types';
import { filterEligibleTripPlaces } from './trip-place-eligibility';
import {
  rotateClassicCityLabels,
  selectPlaceCandidate,
  type PlaceSearchService,
  type ResolvedTripPlaceStop,
  type ResolvedTripPlanDay,
  type ResolvedTripPlanSuggestion,
} from './trip-place-resolver';
import { resolveStopDuration } from './trip-stop-duration-resolver';
import { haversineMeters, isFiniteGeoPoint } from './trip-route-enricher';
import type { TripPlaceSuggestion } from './trip-plan-generator';
import { LONG_STAY_MINUTES, resolveTripPace } from './trip-day-density-planner';

export const CORE_COMPLETION_SEARCHES_PER_MISSING = 2;
export const CORE_COMPLETION_MAX_DISTANCE_METERS = 25_000;

function isCoreStop(stop: ResolvedTripPlaceStop): boolean {
  return stop.place.category !== 'restaurant'
    && stop.place.category !== 'cafe'
    && stop.place.category !== 'transport'
    && stop.place.category !== 'hotel';
}

function isRejectedCategory(place: Place): boolean {
  return place.category === 'restaurant'
    || place.category === 'cafe'
    || place.category === 'shopping'
    || place.category === 'hotel'
    || place.category === 'transport';
}

function tokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s\u3000，。！？、；：""''“”‘’《》【】（）()[\].,!?;:·\-—_/\\]+/)
    .filter((token) => token.length >= 2);
}

function associationScore(
  place: Place,
  dayTitle: string,
  cores: readonly ResolvedTripPlaceStop[],
): number {
  const hay = `${place.name}${place.category}`.normalize('NFKC').toLowerCase();
  let hits = 0;
  for (const token of tokens(dayTitle)) {
    if (hay.includes(token)) {
      hits += 1;
    }
  }
  for (const core of cores) {
    for (const token of tokens(core.place.name)) {
      if (hay.includes(token)) {
        hits += 1;
      }
    }
    if (place.category === core.place.category) {
      hits += 1;
    }
  }
  return -hits;
}

function distanceScore(candidate: Place, anchors: readonly Place[]): number {
  const usable = anchors.filter((place) => isFiniteGeoPoint(place));
  if (!isFiniteGeoPoint(candidate) || usable.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.min(...usable.map((anchor) => haversineMeters(candidate, anchor)));
}

function sightSuggestion(query: string): TripPlaceSuggestion {
  return {
    name: query,
    query,
    category: 'sight',
    suggestedStartTime: '14:30',
    suggestedDurationMinutes: 90,
    reason: '根据当天主题补充的可到访地点。',
  };
}

function uniqueQueries(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

export function coreCompletionQueries(input: {
  destination: string;
  day: Pick<ResolvedTripPlanDay, 'title' | 'dayNumber'>;
  cores: readonly ResolvedTripPlaceStop[];
  preferenceTerms?: readonly string[];
  hasExplicitTravelPreferences?: boolean;
}): string[] {
  const queries: string[] = [];
  for (const core of input.cores) {
    queries.push(`${core.place.name} 附近 景点`);
  }
  const title = input.day.title.trim();
  if (title !== '') {
    queries.push(`${input.destination} ${title} 景点`);
  }
  if (input.hasExplicitTravelPreferences === true) {
    for (const term of input.preferenceTerms ?? []) {
      const cleaned = term.trim();
      if (cleaned !== '') {
        queries.push(`${input.destination} ${cleaned} 景点`);
      }
    }
  } else {
    for (const label of rotateClassicCityLabels(input.day.dayNumber)) {
      if (label === '城市漫步') {
        continue;
      }
      queries.push(`${input.destination} ${label}`);
    }
  }
  return uniqueQueries(queries);
}

export function dayNeedsCorePlaceCompletion(
  day: ResolvedTripPlanDay,
  pace?: TripPace,
): boolean {
  const cores = day.stops.filter((stop) => isCoreStop(stop));
  const resolvedPace = resolveTripPace(pace);
  if (resolvedPace === 'relaxed') {
    return cores.length < 2;
  }
  if (cores.length >= 3) {
    return false;
  }
  if (
    cores.length === 2
    && cores.some((stop) => stop.suggestedDurationMinutes >= LONG_STAY_MINUTES)
  ) {
    return false;
  }
  return true;
}

function rankCandidates(
  candidates: readonly Place[],
  suggestion: TripPlaceSuggestion,
  used: ReadonlySet<string>,
  dayTitle: string,
  cores: readonly ResolvedTripPlaceStop[],
  city: string,
): Place[] {
  const anchors = cores.map((stop) => stop.place);
  const eligible = filterEligibleTripPlaces(candidates, suggestion)
    .filter((place) => (
      !used.has(place.id)
      && !isRejectedCategory(place)
      && isFiniteGeoPoint(place)
      && (place.category === 'attraction' || place.category === 'activity')
      && distanceScore(place, anchors) <= CORE_COMPLETION_MAX_DISTANCE_METERS
    ));
  return [...eligible].sort((left, right) => {
    const association = associationScore(left, dayTitle, cores) - associationScore(right, dayTitle, cores);
    if (association !== 0) {
      return association;
    }
    const distance = distanceScore(left, anchors) - distanceScore(right, anchors);
    if (distance !== 0) {
      return distance;
    }
    const selected = selectPlaceCandidate(
      [left, right],
      suggestion,
      used,
      { destination: city },
    );
    if (selected !== 'NO_MATCH' && selected !== 'DUPLICATE_MATCH') {
      return selected.id === left.id ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

async function searchOnce(
  cache: Map<string, Place[]>,
  placeSearch: PlaceSearchService,
  query: string,
  city: string,
  signal?: AbortSignal,
): Promise<Place[]> {
  const cached = cache.get(query);
  if (cached) {
    return cached;
  }
  const found = await placeSearch.search({
    query,
    city,
    limit: 5,
    ...(signal ? { signal } : {}),
  });
  const list = Array.isArray(found) ? found : [];
  cache.set(query, list);
  return list;
}

export async function completeResolvedTripCorePlaces(input: {
  plan: ResolvedTripPlanSuggestion;
  destination: string;
  pace?: TripPace;
  placeSearch: PlaceSearchService;
  hasExplicitTravelPreferences?: boolean;
  preferenceTerms?: readonly string[];
  signal?: AbortSignal;
}): Promise<ResolvedTripPlanSuggestion> {
  const used = new Set(input.plan.days.flatMap((day) => day.stops.map((stop) => stop.place.id)));
  const cache = new Map<string, Place[]>();
  const days: ResolvedTripPlanDay[] = [];

  for (const day of input.plan.days) {
    const nextStops = day.stops.map((stop) => ({
      ...stop,
      place: { ...stop.place },
    }));
    if (!dayNeedsCorePlaceCompletion({ ...day, stops: nextStops }, input.pace)) {
      days.push({ ...day, stops: nextStops });
      continue;
    }
    const missing = Math.max(
      0,
      (resolveTripPace(input.pace) === 'relaxed' ? 2 : 3) - nextStops.filter((stop) => isCoreStop(stop)).length,
    );
    const queries = coreCompletionQueries({
      destination: input.destination,
      day,
      cores: nextStops.filter((stop) => isCoreStop(stop)),
      preferenceTerms: input.preferenceTerms,
      hasExplicitTravelPreferences: input.hasExplicitTravelPreferences,
    });
    let searches = 0;
    const searchBudget = missing * CORE_COMPLETION_SEARCHES_PER_MISSING;
    for (const query of queries) {
      if (nextStops.filter((stop) => isCoreStop(stop)).length >= (resolveTripPace(input.pace) === 'relaxed' ? 2 : 3)) {
        break;
      }
      if (searches >= searchBudget) {
        break;
      }
      searches += 1;
      const suggestion = sightSuggestion(query);
      const found = await searchOnce(cache, input.placeSearch, query, input.destination, input.signal);
      const ranked = rankCandidates(
        found,
        suggestion,
        used,
        day.title,
        nextStops.filter((stop) => isCoreStop(stop)),
        input.destination,
      );
      const picked = ranked[0];
      if (!picked) {
        continue;
      }
      used.add(picked.id);
      const duration = resolveStopDuration({
        place: picked,
        suggestionCategory: 'sight',
        pace: input.pace,
        destination: input.destination,
      });
      nextStops.push({
        place: { ...picked },
        category: 'sight',
        suggestedStartTime: '15:30',
        suggestedDurationMinutes: duration.suggestedDurationMinutes,
        reason: suggestion.reason,
        sourceQuery: query,
        resolutionSource: 'DAY_FALLBACK_MATCH',
      });
    }
    days.push({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: nextStops,
    });
  }

  return {
    title: input.plan.title,
    summary: input.plan.summary,
    unresolved: input.plan.unresolved.map((item) => ({ ...item })),
    days,
  };
}
