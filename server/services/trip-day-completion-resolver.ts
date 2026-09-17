import type { Place, TripDiningMode, TripPace } from '../../src/domain/trip/types';
import { resolveDiningMode } from './trip-day-density-planner';
import { AmapProviderError } from './amap-http-client';
import { haversineMeters } from './trip-route-enricher';
import {
  selectPlaceCandidate,
  type PlaceSearchService,
  type ResolvedTripPlaceStop,
} from './trip-place-resolver';
import type {
  RouteEnrichedTripPlanDay,
  RouteEnrichedTripPlanSuggestion,
  TripRouteEnricher,
} from './trip-route-enricher';
import { filterEligibleTripPlaces } from './trip-place-eligibility';
import type { TripPlaceSuggestion } from './trip-plan-generator';
import { scheduleEnrichedTripDay } from './trip-time-scheduler';

export const MEAL_SEARCHES_PER_PERIOD = 2;
export const LUNCH_DURATION_MINUTES = 60;
export const DINNER_DURATION_MINUTES = 75;

function foodSuggestion(query: string, start: string, duration: number): TripPlaceSuggestion {
  return {
    name: query,
    query,
    category: 'food',
    suggestedStartTime: start,
    suggestedDurationMinutes: duration,
    reason: '行程用餐。',
  };
}

function parseClock(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function stopEnd(stop: ResolvedTripPlaceStop): number {
  return (parseClock(stop.suggestedStartTime) ?? 0) + stop.suggestedDurationMinutes;
}

function isCoreStop(stop: ResolvedTripPlaceStop): boolean {
  return stop.place.category !== 'restaurant'
    && stop.place.category !== 'cafe'
    && stop.place.category !== 'transport'
    && stop.place.category !== 'hotel';
}

function isLunchStop(stop: ResolvedTripPlaceStop): boolean {
  if (stop.place.category !== 'restaurant' && stop.place.category !== 'cafe') {
    return false;
  }
  const start = parseClock(stop.suggestedStartTime) ?? 0;
  return start >= 11 * 60 && start < 15 * 60;
}

function isDinnerStop(stop: ResolvedTripPlaceStop): boolean {
  if (stop.place.category !== 'restaurant' && stop.place.category !== 'cafe') {
    return false;
  }
  const start = parseClock(stop.suggestedStartTime) ?? 0;
  return start >= 16 * 60 + 30;
}

function distanceScore(candidate: Place, anchors: readonly Place[]): number {
  if (anchors.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return anchors.reduce((sum, anchor) => sum + haversineMeters(candidate, anchor), 0) / anchors.length;
}

function pickRestaurant(
  candidates: readonly Place[],
  suggestion: TripPlaceSuggestion,
  used: ReadonlySet<string>,
  anchors: readonly Place[],
  city: string,
): Place | undefined {
  const eligible = filterEligibleTripPlaces(candidates, suggestion)
    .filter((place) => !used.has(place.id) && (place.category === 'restaurant' || place.category === 'cafe'));
  const ranked = [...eligible].sort((left, right) => {
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
  return ranked[0];
}

async function searchRestaurant(
  placeSearch: PlaceSearchService,
  queries: string[],
  suggestion: TripPlaceSuggestion,
  used: ReadonlySet<string>,
  anchors: readonly Place[],
  city: string,
  signal?: AbortSignal,
): Promise<Place | undefined> {
  let searches = 0;
  for (const query of queries) {
    if (searches >= MEAL_SEARCHES_PER_PERIOD) {
      break;
    }
    searches += 1;
    const found = await placeSearch.search({ query, city, limit: 5, ...(signal ? { signal } : {}) });
    if (!Array.isArray(found)) {
      continue;
    }
    const picked = pickRestaurant(found, { ...suggestion, query, name: query }, used, anchors, city);
    if (picked) {
      return picked;
    }
  }
  return undefined;
}

function insertStop(
  stops: ResolvedTripPlaceStop[],
  next: ResolvedTripPlaceStop,
  afterIndex: number,
): ResolvedTripPlaceStop[] {
  const copy = stops.map((stop) => ({
    ...stop,
    place: { ...stop.place },
  }));
  copy.splice(afterIndex + 1, 0, next);
  return copy;
}

export async function completeEnrichedTripPlan(input: {
  plan: RouteEnrichedTripPlanSuggestion;
  destination: string;
  pace?: TripPace;
  diningMode?: TripDiningMode;
  placeSearch: PlaceSearchService;
  routeEnricher: TripRouteEnricher;
  signal?: AbortSignal;
}): Promise<RouteEnrichedTripPlanSuggestion> {
  if (resolveDiningMode(input.diningMode) !== 'arranged') {
    return {
      title: input.plan.title,
      summary: input.plan.summary,
      unresolved: input.plan.unresolved,
      days: input.plan.days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) => ({ ...stop, place: { ...stop.place } })),
        routes: day.routes.map((route) => ({
          ...route,
          polyline: route.polyline.map((point) => ({ ...point })),
        })),
        unresolvedRoutes: [...day.unresolvedRoutes],
      })),
    };
  }
  const used = new Set(input.plan.days.flatMap((day) => day.stops.map((stop) => stop.place.id)));
  const pace = input.pace === 'relaxed' || input.pace === 'packed' ? input.pace : 'balanced';
  const nextDays: RouteEnrichedTripPlanDay[] = [];

  for (const day of input.plan.days) {
    let stops = day.stops.map((stop) => ({
      ...stop,
      place: { ...stop.place },
    }));
    const cores = stops.filter((stop) => isCoreStop(stop));
    let changed = false;

    if (!stops.some((stop) => isLunchStop(stop)) && cores.length > 0) {
      const morning = cores[0];
      const afternoon = cores[1];
      const anchors = [morning.place, ...(afternoon ? [afternoon.place] : [])];
      const lunchStart = formatClock(Math.max(stopEnd(morning), 11 * 60 + 30));
      const suggestion = foodSuggestion(`${morning.place.name}餐厅`, lunchStart, LUNCH_DURATION_MINUTES);
      try {
        const restaurant = await searchRestaurant(
          input.placeSearch,
          [`${morning.place.name}餐厅`, `${input.destination}餐厅`],
          suggestion,
          used,
          anchors,
          input.destination,
          input.signal,
        );
        if (restaurant) {
          used.add(restaurant.id);
          const morningIndex = stops.findIndex((stop) => stop.place.id === morning.place.id);
          stops = insertStop(stops, {
            place: restaurant,
            category: 'food',
            suggestedStartTime: lunchStart,
            suggestedDurationMinutes: LUNCH_DURATION_MINUTES,
            reason: '午间用餐。',
            sourceQuery: `${morning.place.name}餐厅`,
          }, morningIndex);
          changed = true;
        }
      } catch (error) {
        if (error instanceof AmapProviderError) {
          throw error;
        }
        throw error;
      }
    }

    const lastCore = [...stops].reverse().find((stop) => isCoreStop(stop));
    const lastEnd = lastCore ? stopEnd(lastCore) : 0;
    const packedLate = pace === 'packed' && lastEnd >= 18 * 60;
    if (!packedLate && !stops.some((stop) => isDinnerStop(stop)) && lastCore && lastEnd < 17 * 60) {
      const dinnerStart = formatClock(lastEnd);
      const suggestion = foodSuggestion(`${lastCore.place.name}晚餐`, dinnerStart, DINNER_DURATION_MINUTES);
      const restaurant = await searchRestaurant(
        input.placeSearch,
        [`${lastCore.place.name}晚餐`, `${input.destination}餐厅`],
        suggestion,
        used,
        [lastCore.place],
        input.destination,
        input.signal,
      );
      if (restaurant) {
        used.add(restaurant.id);
        const lastIndex = stops.findIndex((stop) => stop.place.id === lastCore.place.id);
        stops = insertStop(stops, {
          place: restaurant,
          category: 'food',
          suggestedStartTime: dinnerStart,
          suggestedDurationMinutes: DINNER_DURATION_MINUTES,
          reason: '晚间用餐。',
          sourceQuery: `${lastCore.place.name}晚餐`,
        }, lastIndex);
        changed = true;
      }
    }

    if (!changed) {
      nextDays.push({
        ...day,
        stops,
        routes: day.routes.map((route) => ({
          ...route,
          polyline: route.polyline.map((point) => ({ ...point })),
        })),
        unresolvedRoutes: [...day.unresolvedRoutes],
      });
      continue;
    }

    const timed = {
      title: input.plan.title,
      summary: input.plan.summary,
      unresolved: input.plan.unresolved,
      days: [{
        dayNumber: 1,
        title: day.title,
        summary: day.summary,
        stops,
      }],
    };
    try {
      const enriched = await input.routeEnricher.enrich({
        plan: timed,
        pace: input.pace,
        signal: input.signal,
      });
      nextDays.push({
        dayNumber: day.dayNumber,
        title: day.title,
        summary: day.summary,
        stops: (enriched.days[0]?.stops ?? stops).map((stop) => ({
          ...stop,
          place: { ...stop.place },
        })),
        routes: (enriched.days[0]?.routes ?? []).map((route) => ({
          ...route,
          polyline: route.polyline.map((point) => ({ ...point })),
        })),
        unresolvedRoutes: [...(enriched.days[0]?.unresolvedRoutes ?? [])],
      });
    } catch (error) {
      if (
        error instanceof AmapProviderError
        && (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_UNAVAILABLE')
        && (day.routes.length === 0 || day.unresolvedRoutes.length > 0)
      ) {
        nextDays.push({
          ...day,
          stops,
          routes: day.routes.map((route) => ({
            ...route,
            polyline: route.polyline.map((point) => ({ ...point })),
          })),
          unresolvedRoutes: [...day.unresolvedRoutes],
        });
        continue;
      }
      throw error;
    }
  }

  return {
    title: input.plan.title,
    summary: input.plan.summary,
    unresolved: input.plan.unresolved,
    days: nextDays.map((day) => ({
      ...scheduleEnrichedTripDay({
        ...day,
        dayNumber: 1,
      }),
      dayNumber: day.dayNumber,
    })),
  };
}
