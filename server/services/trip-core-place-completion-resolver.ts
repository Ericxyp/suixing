import type { Place, TripPace } from '../../src/domain/trip/types';
import type { PlanningPolicyV1 } from '../../src/domain/trip/profile';
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
import { rerankCoreCompletionCandidatesV1 } from './trip-core-candidate-ranking-v1';
import {
  runCoreCombinationSnapshotShadowV1,
  scoreDayCoreCombinationSnapshotV1,
  scorePreRouteCoreCombinationV1,
  selectCanaryCoreCompletionCandidateV1,
  snapshotCoreCompletionCandidatesV1,
  type CanaryCoreCompletionCandidateV1,
  type CoreCompletionSlotSnapshotV1,
} from './trip-core-combination-snapshot-v1';
import type {
  PartyContextV1,
  TravelProfileSignals,
  TripConstraintsV1,
  TripIntentV1,
} from '../../src/domain/trip/profile';

export const CORE_COMPLETION_SEARCHES_PER_MISSING = 2;
export const CORE_COMPLETION_MAX_DISTANCE_METERS = 25_000;

function isCoreStop(stop: ResolvedTripPlaceStop): boolean {
  return stop.place.category !== 'restaurant'
    && stop.place.category !== 'cafe'
    && stop.place.category !== 'shopping'
    && stop.place.category !== 'transport'
    && stop.place.category !== 'hotel';
}

const STYLE_PREFERENCE_TERMS = [
  '咖啡',
  '咖啡店',
  '美食',
  '餐饮',
  '餐厅',
  '拍照',
  '摄影',
  '购物',
  '商场',
  '夜生活',
  'coffee',
  'food',
  'photography',
  'shopping',
  'nightlife',
] as const;

const CORE_INTEREST_KEY_TERMS: Record<string, string> = {
  history: '历史文化',
  culture_art: '历史文化',
  nature: '公园',
  architecture: '建筑',
};

export function isStyleCoreCompletionTerm(term: string): boolean {
  const normalized = term.normalize('NFKC').trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return STYLE_PREFERENCE_TERMS.some((item) => (
    normalized === item || normalized.includes(item)
  ));
}

export function coreCompletionTermFromPreference(term: string): string | undefined {
  const raw = term.normalize('NFKC').trim();
  if (raw === '' || isStyleCoreCompletionTerm(raw)) {
    return undefined;
  }
  const mapped = CORE_INTEREST_KEY_TERMS[raw.toLowerCase()];
  if (mapped) {
    return mapped;
  }
  if (/历史|文化|博物馆|古迹|公园|建筑|自然|艺术|地标|街区/.test(raw)) {
    return raw;
  }
  return undefined;
}

function hasHistoryCoreIntent(terms: readonly string[]): boolean {
  return terms.some((term) => {
    const raw = term.normalize('NFKC').trim().toLowerCase();
    return /历史|文化|博物馆|古迹|history|culture_art|culture/.test(raw);
  });
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
  const city = input.destination.trim();
  for (const core of input.cores) {
    queries.push(`${core.place.name} 附近 景点`);
  }
  const title = input.day.title.trim();
  if (title !== '') {
    queries.push(`${city} ${title} 景点`);
  }
  const preferenceTerms = input.preferenceTerms ?? [];
  const coreTerms = uniqueQueries(
    preferenceTerms
      .map((term) => coreCompletionTermFromPreference(term))
      .filter((term): term is string => term !== undefined),
  );
  for (const term of coreTerms) {
    queries.push(`${city} ${term} 景点`);
  }
  if (hasHistoryCoreIntent(preferenceTerms) || coreTerms.some((term) => /历史|文化/.test(term))) {
    queries.push(`${city} 历史文化 景点`);
  }
  queries.push(`${city} 博物馆`);
  queries.push(`${city} 公园`);
  queries.push(`${city} 历史街区`);
  queries.push(`${city} 地标`);
  if (input.hasExplicitTravelPreferences !== true && coreTerms.length === 0) {
    for (const label of rotateClassicCityLabels(input.day.dayNumber)) {
      if (label === '城市漫步') {
        continue;
      }
      queries.push(`${city}${label}`);
    }
  }
  return uniqueQueries(queries);
}

export function dayNeedsCorePlaceCompletion(
  day: ResolvedTripPlanDay,
  pace?: TripPace,
  targetCorePlacesPerDay?: 2 | 3,
): boolean {
  const cores = day.stops.filter((stop) => isCoreStop(stop));
  const target = targetCorePlacesPerDay ?? (resolveTripPace(pace) === 'relaxed' ? 2 : 3);
  if (target <= 2) {
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

function targetCoreCount(pace?: TripPace, policy?: PlanningPolicyV1): 2 | 3 {
  return policy?.targetCorePlacesPerDay ?? (resolveTripPace(pace) === 'relaxed' ? 2 : 3);
}

function maxCoreDistance(policy?: PlanningPolicyV1): number {
  return policy?.maxCoreAreaDistanceMeters ?? CORE_COMPLETION_MAX_DISTANCE_METERS;
}

function rankCandidates(
  candidates: readonly Place[],
  suggestion: TripPlaceSuggestion,
  used: ReadonlySet<string>,
  dayTitle: string,
  cores: readonly ResolvedTripPlaceStop[],
  city: string,
  maxDistanceMeters: number,
): Place[] {
  const anchors = cores.map((stop) => stop.place);
  const eligible = filterEligibleTripPlaces(candidates, suggestion)
    .filter((place) => (
      !used.has(place.id)
      && !isRejectedCategory(place)
      && isFiniteGeoPoint(place)
      && (place.category === 'attraction' || place.category === 'activity')
      && distanceScore(place, anchors) <= maxDistanceMeters
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
  policy?: PlanningPolicyV1;
  placeSearch: PlaceSearchService;
  hasExplicitTravelPreferences?: boolean;
  preferenceTerms?: readonly string[];
  signal?: AbortSignal;
  scoringContext?: {
    profileSignals?: TravelProfileSignals;
    tripIntent?: TripIntentV1;
    partyContext?: PartyContextV1;
    constraints?: TripConstraintsV1;
  };
}): Promise<ResolvedTripPlanSuggestion> {
  const used = new Set(input.plan.days.flatMap((day) => day.stops.map((stop) => stop.place.id)));
  const cache = new Map<string, Place[]>();
  const completedByNumber = new Map<number, ResolvedTripPlanDay>();
  const previousDayCoreStops: Array<{ dayNumber: number; place: Place }> = [];
  const target = targetCoreCount(input.pace, input.policy);
  const maxDistance = maxCoreDistance(input.policy);
  const orderedDays = [...input.plan.days].sort((left, right) => left.dayNumber - right.dayNumber);

  for (const day of orderedDays) {
    const nextStops = day.stops.map((stop) => ({
      ...stop,
      place: { ...stop.place },
    }));
    if (!dayNeedsCorePlaceCompletion({ ...day, stops: nextStops }, input.pace, target)) {
      const finished = { ...day, stops: nextStops };
      completedByNumber.set(day.dayNumber, finished);
      for (const stop of nextStops.filter((item) => isCoreStop(item))) {
        previousDayCoreStops.push({ dayNumber: day.dayNumber, place: stop.place });
      }
      continue;
    }
    const originalCores = nextStops.filter((stop) => isCoreStop(stop));
    const missing = Math.max(
      0,
      target - originalCores.length,
    );
    const queries = coreCompletionQueries({
      destination: input.destination,
      day,
      cores: originalCores,
      preferenceTerms: input.preferenceTerms,
      hasExplicitTravelPreferences: input.hasExplicitTravelPreferences,
    });
    let searches = 0;
    const searchBudget = missing * CORE_COMPLETION_SEARCHES_PER_MISSING;
    const daySlots: CoreCompletionSlotSnapshotV1[] = [];
    for (const query of queries) {
      if (nextStops.filter((stop) => isCoreStop(stop)).length >= target) {
        break;
      }
      if (searches >= searchBudget) {
        break;
      }
      searches += 1;
      const suggestion = sightSuggestion(query);
      const found = await searchOnce(cache, input.placeSearch, query, input.destination, input.signal);
      const cores = nextStops.filter((stop) => isCoreStop(stop));
      const legacyRanked = rankCandidates(
        found,
        suggestion,
        used,
        day.title,
        cores,
        input.destination,
        maxDistance,
      );
      const rankingContext = {
        usedPlaceIds: used,
        anchors: cores.map((stop) => stop.place),
        policy: input.policy,
        profileSignals: input.scoringContext?.profileSignals,
        tripIntent: input.scoringContext?.tripIntent,
        partyContext: input.scoringContext?.partyContext,
        constraints: input.scoringContext?.constraints,
        existingCoreStops: cores.map((stop) => stop.place),
        existingResolvedCores: cores.map((stop) => ({
          place: stop.place,
          suggestedDurationMinutes: stop.suggestedDurationMinutes,
        })),
        previousDayCoreStops: previousDayCoreStops.map((stop) => ({
          dayNumber: stop.dayNumber,
          place: stop.place,
        })),
        queryText: suggestion.query,
      };
      const ranked = input.scoringContext
        ? rerankCoreCompletionCandidatesV1(legacyRanked, rankingContext)
        : legacyRanked;
      const baseline = ranked[0];
      runCoreCombinationSnapshotShadowV1(() => {
        if (!baseline || daySlots.length >= 2) {
          return;
        }
        daySlots.push({
          dayNumber: day.dayNumber,
          slotIndex: daySlots.length,
          candidates: snapshotCoreCompletionCandidatesV1(
            ranked,
            legacyRanked,
            input.scoringContext ? rankingContext : undefined,
          ),
        });
      });
      if (!baseline) {
        continue;
      }
      let picked = baseline;
      if (input.scoringContext && missing === 1) {
        try {
          const snapshots = snapshotCoreCompletionCandidatesV1(
            ranked,
            legacyRanked,
            rankingContext,
          );
          const scheduled: CanaryCoreCompletionCandidateV1[] = snapshots.map((item, rerankIndex) => ({
            place: item.place,
            preRouteScore: scorePreRouteCoreCombinationV1({
              dayNumber: day.dayNumber,
              originalCores,
              comboPlaces: [item.place],
              policy: input.policy,
              profileSignals: input.scoringContext?.profileSignals,
              tripIntent: input.scoringContext?.tripIntent,
              partyContext: input.scoringContext?.partyContext,
              constraints: input.scoringContext?.constraints,
              previousDayCoreStops,
            }),
            suggestedStartTime: '15:30',
            suggestedDurationMinutes: resolveStopDuration({
              place: item.place,
              suggestionCategory: 'sight',
              pace: input.pace,
              destination: input.destination,
            }).suggestedDurationMinutes,
            rerankIndex,
          }));
          const baselineScheduled = scheduled.find((item) => item.place.id === baseline.id);
          if (baselineScheduled) {
            picked = selectCanaryCoreCompletionCandidateV1({
              baseline: baselineScheduled,
              alternatives: scheduled.filter((item) => item.place.id !== baseline.id),
              missingCoreCount: missing,
              scoringContext: input.scoringContext,
            }) ?? baseline;
          }
        } catch {
          picked = baseline;
        }
      }
      if (!picked) {
        picked = baseline;
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
    runCoreCombinationSnapshotShadowV1(() => {
      const snapshot = scoreDayCoreCombinationSnapshotV1({
        dayNumber: day.dayNumber,
        slots: daySlots,
        originalCores,
        policy: input.policy,
        profileSignals: input.scoringContext?.profileSignals,
        tripIntent: input.scoringContext?.tripIntent,
        partyContext: input.scoringContext?.partyContext,
        constraints: input.scoringContext?.constraints,
        previousDayCoreStops,
      });
      void snapshot;
    });
    const finished = {
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: nextStops,
    };
    completedByNumber.set(day.dayNumber, finished);
    for (const stop of nextStops.filter((item) => isCoreStop(item))) {
      previousDayCoreStops.push({ dayNumber: day.dayNumber, place: stop.place });
    }
  }

  return {
    title: input.plan.title,
    summary: input.plan.summary,
    unresolved: input.plan.unresolved.map((item) => ({ ...item })),
    days: input.plan.days.map((day) => {
      const finished = completedByNumber.get(day.dayNumber);
      return finished ?? {
        ...day,
        stops: day.stops.map((stop) => ({ ...stop, place: { ...stop.place } })),
      };
    }),
  };
}
