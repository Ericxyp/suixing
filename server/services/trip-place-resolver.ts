import type { Place, TripPlaceType } from '../../src/domain/trip/types';
import { AmapProviderError } from './amap-http-client';
import type { AmapPlaceService, PlaceSearchInput } from './amap-place-service';
import {
  filterEligibleTripPlaces,
  isForbiddenMainSubstitute,
} from './trip-place-eligibility';
import type {
  TripPlanPlaceCategory,
  TripPlanSuggestion,
  TripPlaceSuggestion,
} from './trip-plan-generator';

export type PlaceSearchService = Pick<AmapPlaceService, 'search'> & Partial<Pick<AmapPlaceService, 'getByProviderPlaceId'>>;

export type UnresolvedTripPlaceReason =
  | 'NO_MATCH'
  | 'DUPLICATE_MATCH'
  | 'SEARCH_UNAVAILABLE';

export type ResolutionOutcome =
  | 'PRIMARY_MATCH'
  | 'QUERY_FALLBACK_MATCH'
  | 'DAY_FALLBACK_MATCH'
  | 'NO_MATCH'
  | 'DUPLICATE_MATCH'
  | 'PROVIDER_FAILURE';

export interface ResolvedTripPlaceStop {
  place: Place;
  category: TripPlanPlaceCategory;
  suggestedStartTime: string;
  suggestedDurationMinutes: number;
  reason: string;
  sourceQuery: string;
  resolutionSource?: Extract<
    ResolutionOutcome,
    'PRIMARY_MATCH' | 'QUERY_FALLBACK_MATCH' | 'DAY_FALLBACK_MATCH'
  >;
}

export interface ResolvedTripPlanDay {
  dayNumber: number;
  title: string;
  summary: string;
  stops: ResolvedTripPlaceStop[];
}

export interface UnresolvedTripPlace {
  dayNumber: number;
  name: string;
  query: string;
  reason: UnresolvedTripPlaceReason;
}

export interface ResolvedTripPlanSuggestion {
  title: string;
  summary: string;
  days: ResolvedTripPlanDay[];
  unresolved: UnresolvedTripPlace[];
}

export interface ResolveTripPlacesInput {
  destination: string;
  plan: TripPlanSuggestion;
  signal?: AbortSignal;
  hasExplicitTravelPreferences?: boolean;
}

export interface TripPlaceResolver {
  resolve(input: ResolveTripPlacesInput): Promise<ResolvedTripPlanSuggestion>;
}

export const TRIP_PLACE_SEARCH_LIMIT = 5;
export const TRIP_PLACE_SEARCH_CONCURRENCY = 3;
export const TRIP_PLACE_QUERY_FALLBACK_LIMIT = 3;
export const DAY_FALLBACK_REASON = '根据当前城市主题补充的可到访地点。';
export const DAY_FALLBACK_FIRST_START = '10:00';
export const DAY_FALLBACK_FIRST_DURATION_MINUTES = 120;
export const DAY_FALLBACK_SECOND_START = '14:30';
export const DAY_FALLBACK_SECOND_DURATION_MINUTES = 90;
export const DAY_FALLBACK_TARGET_STOPS = 2;

export const CLASSIC_CITY_FALLBACK_LABELS = [
  '景点',
  '博物馆',
  '公园',
  '历史街区',
  '城市漫步',
] as const;

export function dayFallbackSearchLimit(missingCount: number, classicRoute = false): number {
  return Math.max(0, missingCount) + (classicRoute ? 2 : 1);
}

export function rotateClassicCityLabels(dayNumber: number): string[] {
  const labels = [...CLASSIC_CITY_FALLBACK_LABELS];
  const offset = ((Math.max(dayNumber, 1) - 1) % labels.length);
  return [...labels.slice(offset), ...labels.slice(0, offset)];
}

const DAY_FALLBACK_SUFFIX: Record<TripPlanPlaceCategory, string> = {
  sight: '景点',
  activity: '景点',
  coffee: '咖啡馆',
  food: '美食',
  shopping: '商场',
  hotel: '景点',
  other: '景点',
};

const INVALID_REQUEST_MESSAGE = '行程地点解析请求无效，请调整后重试。';
const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';
const MAX_DESTINATION_LENGTH = 80;
const PLAN_CATEGORY_TO_PLACE: Record<TripPlanPlaceCategory, TripPlaceType | undefined> = {
  sight: 'attraction',
  food: 'restaurant',
  coffee: 'cafe',
  hotel: 'hotel',
  shopping: 'shopping',
  activity: 'activity',
  other: undefined,
};

interface IndexedPlaceQuery {
  dayNumber: number;
  dayIndex: number;
  suggestion: TripPlaceSuggestion;
}

interface PlaceSearchOutcome {
  places?: Place[];
  unavailable?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new AmapProviderError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
}

function providerError(): never {
  throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
}

function isSearchUnavailable(error: unknown): boolean {
  return (
    error instanceof AmapProviderError
    && (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_UNAVAILABLE')
  );
}

const PLACE_NAME_PUNCT = /[\s\u3000，。！？、；：""''“”‘’《》【】（）()[\].,!?;:·\-—_/\\]+/g;

export function normalizePlaceName(value: string): string {
  return value.normalize('NFKC').replace(PLACE_NAME_PUNCT, '').toLowerCase();
}

export function normalizePlaceSearchQuery(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[，。！？、；：""''“”‘’《》【】[\].,!?;:·\-—_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function placeQueryFallbacks(
  destination: string,
  suggestion: TripPlaceSuggestion,
): string[] {
  const primary = suggestion.query.trim();
  const normalized = normalizePlaceSearchQuery(suggestion.query);
  const candidates = [
    suggestion.name.trim(),
    normalized,
    `${destination.trim()}${normalized}`,
  ];
  const unique: string[] = [];
  const seen = new Set([primary]);
  for (const candidate of candidates) {
    if (candidate === '' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    unique.push(candidate);
    if (unique.length >= TRIP_PLACE_QUERY_FALLBACK_LIMIT) {
      break;
    }
  }
  return unique;
}

export function dayFallbackQuery(
  destination: string,
  category: TripPlanPlaceCategory,
): string {
  return `${destination.trim()}${DAY_FALLBACK_SUFFIX[category]}`;
}

export function dayFallbackQueries(
  destination: string,
  unmatchedSuggestions: readonly TripPlaceSuggestion[],
  searchLimit: number,
  options?: { classicRoute?: boolean; dayNumber?: number },
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (query: string) => {
    if (query === '' || seen.has(query) || queries.length >= searchLimit) {
      return;
    }
    seen.add(query);
    queries.push(query);
  };
  const city = destination.trim();
  if (options?.classicRoute === true) {
    for (const label of rotateClassicCityLabels(options.dayNumber ?? 1)) {
      add(`${city}${label}`);
    }
    return queries;
  }
  for (const suggestion of unmatchedSuggestions) {
    if (suggestion.category === 'hotel') {
      add(`${city}景点`);
      continue;
    }
    add(dayFallbackQuery(destination, suggestion.category));
  }
  for (const label of CLASSIC_CITY_FALLBACK_LABELS) {
    add(`${city}${label}`);
  }
  return queries;
}

export function parseSuggestedStartMinutes(value: string): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function fallbackStopSchedule(
  existing: readonly ResolvedTripPlaceStop[],
  fillCount: number,
): Array<{ suggestedStartTime: string; suggestedDurationMinutes: number }> {
  if (existing.length === 0) {
    return [
      {
        suggestedStartTime: DAY_FALLBACK_FIRST_START,
        suggestedDurationMinutes: DAY_FALLBACK_FIRST_DURATION_MINUTES,
      },
      {
        suggestedStartTime: DAY_FALLBACK_SECOND_START,
        suggestedDurationMinutes: DAY_FALLBACK_SECOND_DURATION_MINUTES,
      },
    ].slice(0, fillCount);
  }
  const minutes = parseSuggestedStartMinutes(existing[0].suggestedStartTime);
  if (minutes !== undefined && minutes < 13 * 60) {
    return [{
      suggestedStartTime: DAY_FALLBACK_SECOND_START,
      suggestedDurationMinutes: DAY_FALLBACK_SECOND_DURATION_MINUTES,
    }].slice(0, fillCount);
  }
  return [{
    suggestedStartTime: DAY_FALLBACK_FIRST_START,
    suggestedDurationMinutes: DAY_FALLBACK_FIRST_DURATION_MINUTES,
  }].slice(0, fillCount);
}

function isAiResolvedStop(stop: ResolvedTripPlaceStop): boolean {
  return stop.resolutionSource !== 'DAY_FALLBACK_MATCH';
}

export function compareResolvedStops(
  left: ResolvedTripPlaceStop,
  right: ResolvedTripPlaceStop,
): number {
  const leftMinutes = parseSuggestedStartMinutes(left.suggestedStartTime) ?? Number.POSITIVE_INFINITY;
  const rightMinutes = parseSuggestedStartMinutes(right.suggestedStartTime) ?? Number.POSITIVE_INFINITY;
  if (leftMinutes !== rightMinutes) {
    return leftMinutes - rightMinutes;
  }
  const leftFallback = isAiResolvedStop(left) ? 0 : 1;
  const rightFallback = isAiResolvedStop(right) ? 0 : 1;
  return leftFallback - rightFallback;
}

function sortDayStops(stops: ResolvedTripPlaceStop[]): ResolvedTripPlaceStop[] {
  return [...stops].sort(compareResolvedStops);
}

function categoryForFallbackQuery(query: string, destination: string): TripPlanPlaceCategory {
  const city = destination.trim();
  if (query === `${city}咖啡馆`) {
    return 'coffee';
  }
  if (query === `${city}美食`) {
    return 'food';
  }
  if (query === `${city}商场`) {
    return 'shopping';
  }
  return 'sight';
}

function suggestionForFallbackQuery(
  query: string,
  destination: string,
  unmatchedSuggestions: readonly TripPlaceSuggestion[],
): TripPlaceSuggestion {
  const matched = unmatchedSuggestions.find(
    (suggestion) => dayFallbackQuery(destination, suggestion.category) === query,
  );
  if (matched) {
    return matched;
  }
  return {
    name: query,
    query,
    category: categoryForFallbackQuery(query, destination),
    suggestedStartTime: DAY_FALLBACK_FIRST_START,
    suggestedDurationMinutes: DAY_FALLBACK_FIRST_DURATION_MINUTES,
    reason: DAY_FALLBACK_REASON,
  };
}

function pickRankedUnusedPlaces(
  places: readonly Place[],
  suggestion: TripPlaceSuggestion,
  usedPlaceIds: ReadonlySet<string>,
  limit: number,
  context: SelectPlaceCandidateContext,
): Place[] {
  const picked: Place[] = [];
  const blocked = new Set(usedPlaceIds);
  while (picked.length < limit) {
    const next = selectPlaceCandidate([...places], suggestion, blocked, context);
    if (next === 'NO_MATCH' || next === 'DUPLICATE_MATCH') {
      break;
    }
    picked.push(next);
    blocked.add(next.id);
  }
  return picked;
}

function planCategoryFromPlace(category: TripPlaceType): TripPlanPlaceCategory {
  if (category === 'attraction') return 'sight';
  if (category === 'cafe') return 'coffee';
  if (category === 'restaurant') return 'food';
  if (category === 'shopping') return 'shopping';
  if (category === 'hotel') return 'hotel';
  if (category === 'activity') return 'activity';
  return 'other';
}

function clonePlace(place: Place): Place {
  return {
    id: place.id,
    provider: place.provider,
    providerPlaceId: place.providerPlaceId,
    name: place.name,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    category: place.category,
  };
}

function readNonEmptyString(value: unknown): string {
  if (typeof value !== 'string') {
    invalidRequest();
  }
  const text = value.trim();
  if (text === '') {
    invalidRequest();
  }
  return text;
}

function readPlaceSuggestion(value: unknown): TripPlaceSuggestion {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const category = value.category;
  if (
    category !== 'sight'
    && category !== 'food'
    && category !== 'coffee'
    && category !== 'shopping'
    && category !== 'activity'
    && category !== 'other'
  ) {
    invalidRequest();
  }
  if (
    typeof value.suggestedStartTime !== 'string'
    || typeof value.suggestedDurationMinutes !== 'number'
    || !Number.isInteger(value.suggestedDurationMinutes)
  ) {
    invalidRequest();
  }
  return {
    name: readNonEmptyString(value.name),
    query: readNonEmptyString(value.query),
    category,
    suggestedStartTime: value.suggestedStartTime,
    suggestedDurationMinutes: value.suggestedDurationMinutes,
    reason: readNonEmptyString(value.reason),
  };
}

function parseResolveInput(input: ResolveTripPlacesInput): {
  destination: string;
  plan: TripPlanSuggestion;
  classicRoute: boolean;
} {
  if (!isRecord(input)) {
    invalidRequest();
  }
  const destination = readNonEmptyString(input.destination);
  if (destination.length > MAX_DESTINATION_LENGTH) {
    invalidRequest();
  }
  const plan = input.plan;
  if (!isRecord(plan) || !Array.isArray(plan.days) || plan.days.length === 0) {
    invalidRequest();
  }
  const days = plan.days.map((day, index) => {
    if (!isRecord(day)) {
      invalidRequest();
    }
    const expectedDayNumber = index + 1;
    if (day.dayNumber !== expectedDayNumber) {
      invalidRequest();
    }
    if (!Array.isArray(day.placeQueries) || day.placeQueries.length === 0) {
      invalidRequest();
    }
    return {
      dayNumber: expectedDayNumber,
      title: readNonEmptyString(day.title),
      summary: readNonEmptyString(day.summary),
      placeQueries: day.placeQueries.map((place) => readPlaceSuggestion(place)),
    };
  });
  return {
    destination,
    classicRoute: input.hasExplicitTravelPreferences === false,
    plan: {
      title: readNonEmptyString(plan.title),
      summary: readNonEmptyString(plan.summary),
      days,
    },
  };
}

function flattenQueries(plan: TripPlanSuggestion): IndexedPlaceQuery[] {
  return plan.days.flatMap((day, dayIndex) =>
    day.placeQueries.map((suggestion) => ({
      dayNumber: day.dayNumber,
      dayIndex,
      suggestion,
    })),
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function nameMatchRank(placeName: string, candidateName: string): 0 | 1 | 2 {
  if (placeName === '' || candidateName === '') {
    return 2;
  }
  if (placeName === candidateName) {
    return 0;
  }
  if (placeName.includes(candidateName) || candidateName.includes(placeName)) {
    return 1;
  }
  return 2;
}

function categoryMatchRank(
  placeCategory: TripPlaceType,
  suggestionCategory: TripPlanPlaceCategory,
): 0 | 1 {
  const expected = PLAN_CATEGORY_TO_PLACE[suggestionCategory];
  return expected !== undefined && placeCategory === expected ? 0 : 1;
}

function cityMatchRank(address: string, destination: string | undefined): 0 | 1 {
  const city = destination ? normalizePlaceName(destination) : '';
  if (city === '') {
    return 1;
  }
  return normalizePlaceName(address).includes(city) ? 0 : 1;
}

export function addressDistrictToken(address: string): string | undefined {
  const text = address.normalize('NFKC');
  const match = /([^\s\d]{1,8}(?:区|县))/.exec(text);
  if (!match) {
    return undefined;
  }
  const token = normalizePlaceName(match[1]);
  return token === '' ? undefined : token;
}

function areaMatchRank(place: Place, sameDayPlaces: readonly Place[] | undefined): 0 | 1 {
  if (!sameDayPlaces || sameDayPlaces.length === 0) {
    return 1;
  }
  const district = addressDistrictToken(place.address);
  if (!district) {
    return 1;
  }
  return sameDayPlaces.some((item) => addressDistrictToken(item.address) === district) ? 0 : 1;
}

export const LANDMARK_ACCESSORY_TERMS = [
  '游客中心',
  '停车场',
  '服务区',
  '售票处',
  '文创店',
  '入口',
  '出口',
  '码头',
  '商店',
  '餐厅',
  '咖啡',
  '厕所',
  '雕塑',
  '广场',
  '凉亭',
  '亭',
  '楼',
  '阁',
  '门',
  '桥',
] as const;

export type LandmarkCandidateKind = 'main' | 'sub' | 'other';

export type LandmarkSelectionMode =
  | 'MAIN_LANDMARK_MATCH'
  | 'SUB_PLACE_FALLBACK'
  | 'UNFILTERED';

function hasAccessoryTerm(normalized: string): boolean {
  if (normalized === '') {
    return false;
  }
  return LANDMARK_ACCESSORY_TERMS.some((term) => normalized.includes(normalizePlaceName(term)));
}

export function queryHasExplicitAccessory(suggestion: TripPlaceSuggestion): boolean {
  return hasAccessoryTerm(normalizePlaceName(suggestion.query))
    || hasAccessoryTerm(normalizePlaceName(suggestion.name));
}

export function landmarkStem(suggestion: TripPlaceSuggestion): string {
  const name = normalizePlaceName(suggestion.name);
  const query = normalizePlaceName(suggestion.query);
  if (name !== '' && !hasAccessoryTerm(name)) {
    return name;
  }
  if (query !== '' && !hasAccessoryTerm(query)) {
    return query;
  }
  return name || query;
}

export function classifyLandmarkCandidate(
  place: Place,
  suggestion: TripPlaceSuggestion,
): LandmarkCandidateKind {
  const stem = landmarkStem(suggestion);
  const placeName = normalizePlaceName(place.name);
  if (stem === '' || placeName === '') {
    return 'other';
  }
  if (placeName === stem) {
    return 'main';
  }
  if (!placeName.startsWith(stem)) {
    return 'other';
  }
  return hasAccessoryTerm(placeName) ? 'sub' : 'main';
}

export function landmarkSelectionPool(
  unused: readonly Place[],
  suggestion: TripPlaceSuggestion,
): { places: Place[]; mode: LandmarkSelectionMode } {
  if (queryHasExplicitAccessory(suggestion)) {
    return { places: [...unused], mode: 'UNFILTERED' };
  }
  const main = unused.filter((place) => classifyLandmarkCandidate(place, suggestion) === 'main');
  if (main.length > 0) {
    return { places: main, mode: 'MAIN_LANDMARK_MATCH' };
  }
  const sub = unused.filter((place) => (
    classifyLandmarkCandidate(place, suggestion) === 'sub'
    && !isForbiddenMainSubstitute(place)
  ));
  if (sub.length > 0) {
    return { places: sub, mode: 'SUB_PLACE_FALLBACK' };
  }
  const related = unused.some((place) => classifyLandmarkCandidate(place, suggestion) !== 'other');
  if (related) {
    return { places: [], mode: 'SUB_PLACE_FALLBACK' };
  }
  return { places: [...unused], mode: 'UNFILTERED' };
}

export interface SelectPlaceCandidateContext {
  destination?: string;
  sameDayPlaces?: readonly Place[];
}

function comparePlaceCandidates(
  left: Place,
  right: Place,
  suggestion: TripPlaceSuggestion,
  context: SelectPlaceCandidateContext,
): number {
  const candidateName = normalizePlaceName(suggestion.name) || normalizePlaceName(suggestion.query);
  const leftName = nameMatchRank(normalizePlaceName(left.name), candidateName);
  const rightName = nameMatchRank(normalizePlaceName(right.name), candidateName);
  if (leftName !== rightName) {
    return leftName - rightName;
  }
  const leftCategory = categoryMatchRank(left.category, suggestion.category);
  const rightCategory = categoryMatchRank(right.category, suggestion.category);
  if (leftCategory !== rightCategory) {
    return leftCategory - rightCategory;
  }
  const leftCity = cityMatchRank(left.address, context.destination);
  const rightCity = cityMatchRank(right.address, context.destination);
  if (leftCity !== rightCity) {
    return leftCity - rightCity;
  }
  const leftArea = areaMatchRank(left, context.sameDayPlaces);
  const rightArea = areaMatchRank(right, context.sameDayPlaces);
  if (leftArea !== rightArea) {
    return leftArea - rightArea;
  }
  return left.id.localeCompare(right.id);
}

export function selectPlaceCandidate(
  places: Place[],
  suggestion: TripPlaceSuggestion,
  usedPlaceIds: ReadonlySet<string>,
  context: SelectPlaceCandidateContext = {},
): Place | 'NO_MATCH' | 'DUPLICATE_MATCH' {
  if (suggestion.category === 'hotel') {
    return 'NO_MATCH';
  }
  if (places.length === 0) {
    return 'NO_MATCH';
  }
  const unused = places.filter((place) => !usedPlaceIds.has(place.id));
  if (unused.length === 0) {
    return 'DUPLICATE_MATCH';
  }
  const eligible = filterEligibleTripPlaces(unused, suggestion);
  if (eligible.length === 0) {
    return 'NO_MATCH';
  }
  const pool = landmarkSelectionPool(eligible, suggestion).places;
  if (pool.length === 0) {
    return 'NO_MATCH';
  }
  pool.sort((left, right) => comparePlaceCandidates(left, right, suggestion, context));
  return pool[0];
}

function toStop(
  suggestion: TripPlaceSuggestion,
  selected: Place,
  resolutionSource: NonNullable<ResolvedTripPlaceStop['resolutionSource']>,
): ResolvedTripPlaceStop {
  if (selected.category === 'hotel' || suggestion.category === 'hotel') {
    invalidRequest();
  }
  return {
    place: clonePlace(selected),
    category: suggestion.category,
    suggestedStartTime: suggestion.suggestedStartTime,
    suggestedDurationMinutes: suggestion.suggestedDurationMinutes,
    reason: suggestion.reason,
    sourceQuery: suggestion.query,
    resolutionSource,
  };
}

export class AmapTripPlaceResolver implements TripPlaceResolver {
  constructor(private readonly placeSearch: PlaceSearchService) {}

  async resolve(input: ResolveTripPlacesInput): Promise<ResolvedTripPlanSuggestion> {
    const parsed = parseResolveInput(input);
    const queries = flattenQueries(parsed.plan);
    const fallbackCache = new Map<string, PlaceSearchOutcome>();

    const searchOnce = async (query: string): Promise<PlaceSearchOutcome> => {
      const searchInput: PlaceSearchInput = {
        query,
        city: parsed.destination,
        limit: TRIP_PLACE_SEARCH_LIMIT,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      try {
        const places = await this.placeSearch.search(searchInput);
        if (!Array.isArray(places)) {
          providerError();
        }
        return { places };
      } catch (error) {
        if (isSearchUnavailable(error)) {
          return { unavailable: true };
        }
        if (error instanceof AmapProviderError) {
          throw new AmapProviderError(
            error.code,
            error.code === 'INVALID_REQUEST' ? INVALID_REQUEST_MESSAGE : PROVIDER_ERROR_MESSAGE,
          );
        }
        providerError();
      }
    };

    const searchFallback = async (query: string): Promise<PlaceSearchOutcome> => {
      const cached = fallbackCache.get(query);
      if (cached) {
        return cached;
      }
      const outcome = await searchOnce(query);
      fallbackCache.set(query, outcome);
      return outcome;
    };

    let outcomes: PlaceSearchOutcome[];
    try {
      outcomes = await mapWithConcurrency(
        queries,
        TRIP_PLACE_SEARCH_CONCURRENCY,
        async (item) => searchOnce(item.suggestion.query),
      );
    } catch (error) {
      if (error instanceof AmapProviderError) {
        throw error;
      }
      providerError();
    }

    for (const [index, item] of queries.entries()) {
      if (!fallbackCache.has(item.suggestion.query)) {
        fallbackCache.set(item.suggestion.query, outcomes[index]);
      }
    }

    const usedPlaceIds = new Set<string>();
    const days: ResolvedTripPlanDay[] = parsed.plan.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: [],
    }));
    const unresolved: UnresolvedTripPlace[] = [];
    const unmatchedByDay: TripPlaceSuggestion[][] = parsed.plan.days.map(() => []);

    for (const [index, item] of queries.entries()) {
      const outcome = outcomes[index];
      if (outcome.unavailable) {
        unresolved.push({
          dayNumber: item.dayNumber,
          name: item.suggestion.name,
          query: item.suggestion.query,
          reason: 'SEARCH_UNAVAILABLE',
        });
        continue;
      }

      const selectionContext = {
        destination: parsed.destination,
        sameDayPlaces: days[item.dayIndex].stops.map((stop) => stop.place),
      };
      let selected: Place | 'NO_MATCH' | 'DUPLICATE_MATCH' = selectPlaceCandidate(
        outcome.places ?? [],
        item.suggestion,
        usedPlaceIds,
        selectionContext,
      );
      let resolutionSource: NonNullable<ResolvedTripPlaceStop['resolutionSource']> = 'PRIMARY_MATCH';

      if (selected === 'NO_MATCH' || selected === 'DUPLICATE_MATCH') {
        let lastReason: 'NO_MATCH' | 'DUPLICATE_MATCH' = selected;
        let blockedByProvider = false;
        for (const fallbackQuery of placeQueryFallbacks(parsed.destination, item.suggestion)) {
          const fallbackOutcome = await searchFallback(fallbackQuery);
          if (fallbackOutcome.unavailable) {
            unmatchedByDay[item.dayIndex].push(item.suggestion);
            unresolved.push({
              dayNumber: item.dayNumber,
              name: item.suggestion.name,
              query: item.suggestion.query,
              reason: 'SEARCH_UNAVAILABLE',
            });
            blockedByProvider = true;
            break;
          }
          const fallbackSelected = selectPlaceCandidate(
            fallbackOutcome.places ?? [],
            item.suggestion,
            usedPlaceIds,
            selectionContext,
          );
          if (fallbackSelected !== 'NO_MATCH' && fallbackSelected !== 'DUPLICATE_MATCH') {
            selected = fallbackSelected;
            resolutionSource = 'QUERY_FALLBACK_MATCH';
            break;
          }
          lastReason = fallbackSelected;
        }
        if (blockedByProvider) {
          continue;
        }
        if (selected !== 'NO_MATCH' && selected !== 'DUPLICATE_MATCH' && selected.category === 'hotel') {
          selected = 'NO_MATCH';
        }
        if (selected === 'NO_MATCH' || selected === 'DUPLICATE_MATCH') {
          unmatchedByDay[item.dayIndex].push(item.suggestion);
          unresolved.push({
            dayNumber: item.dayNumber,
            name: item.suggestion.name,
            query: item.suggestion.query,
            reason: lastReason,
          });
          continue;
        }
      }

      usedPlaceIds.add(selected.id);
      days[item.dayIndex].stops.push(toStop(item.suggestion, selected, resolutionSource));
    }

    for (const dayIndex of parsed.plan.days.keys()) {
      const allPrimaryUnavailable = queries.every((item, index) => (
        item.dayIndex !== dayIndex || outcomes[index].unavailable
      ));
      if (allPrimaryUnavailable) {
        continue;
      }
      const existingCount = days[dayIndex].stops.length;
      if (existingCount >= DAY_FALLBACK_TARGET_STOPS) {
        continue;
      }
      const missingCount = DAY_FALLBACK_TARGET_STOPS - existingCount;
      const classicRoute = parsed.classicRoute;
      const fallbackQueries = dayFallbackQueries(
        parsed.destination,
        unmatchedByDay[dayIndex],
        dayFallbackSearchLimit(missingCount, classicRoute),
        {
          classicRoute,
          dayNumber: days[dayIndex].dayNumber,
        },
      );
      const picked: Array<{ place: Place; query: string }> = [];
      for (const query of fallbackQueries) {
        if (picked.length >= missingCount) {
          break;
        }
        const fallbackOutcome = await searchFallback(query);
        if (fallbackOutcome.unavailable) {
          continue;
        }
        const blockedIds = new Set([
          ...usedPlaceIds,
          ...picked.map((item) => item.place.id),
        ]);
        const rankingSuggestion = suggestionForFallbackQuery(
          query,
          parsed.destination,
          unmatchedByDay[dayIndex],
        );
        const nextPlaces = pickRankedUnusedPlaces(
          fallbackOutcome.places ?? [],
          rankingSuggestion,
          blockedIds,
          missingCount - picked.length,
          {
            destination: parsed.destination,
            sameDayPlaces: [
              ...days[dayIndex].stops.map((stop) => stop.place),
              ...picked.map((item) => item.place),
            ],
          },
        );
        for (const next of nextPlaces) {
          if (next.category === 'hotel') {
            continue;
          }
          picked.push({ place: next, query });
        }
      }
      if (existingCount + picked.length < DAY_FALLBACK_TARGET_STOPS) {
        continue;
      }
      const schedule = fallbackStopSchedule(days[dayIndex].stops, picked.length);
      picked.forEach((item, index) => {
        if (item.place.category === 'hotel') {
          return;
        }
        usedPlaceIds.add(item.place.id);
        const slot = schedule[index] ?? schedule[schedule.length - 1];
        days[dayIndex].stops.push({
          place: clonePlace(item.place),
          category: planCategoryFromPlace(item.place.category),
          suggestedStartTime: slot.suggestedStartTime,
          suggestedDurationMinutes: slot.suggestedDurationMinutes,
          reason: DAY_FALLBACK_REASON,
          sourceQuery: item.query,
          resolutionSource: 'DAY_FALLBACK_MATCH',
        });
      });
      days[dayIndex].stops = sortDayStops(days[dayIndex].stops);
    }

    return {
      title: parsed.plan.title,
      summary: parsed.plan.summary,
      days,
      unresolved,
    };
  }
}
