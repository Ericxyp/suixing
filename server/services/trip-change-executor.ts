import {
  Place,
  TransportMode,
  Trip,
  TripDay,
  TripExperienceType,
  TripPlace,
  TripPlaceType,
  TripRoute,
  TripScheduleItem,
} from '../../src/domain/trip/types';
import { AmapProviderError } from './amap-http-client';
import { completeEnrichedTripPlan } from './trip-day-completion-resolver';
import {
  completeResolvedTripCorePlaces,
  dayNeedsCorePlaceCompletion,
} from './trip-core-place-completion-resolver';
import { isCoreTripPlace, planDaySchedule } from './trip-day-density-planner';
import { searchMealDiningPlaces } from './trip-meal-options';
import { validateDayItineraryCompleteness } from './trip-itinerary-completeness-validator';
import { planningPolicyFromTripContext } from '../../src/services/travel-profile-policy';
import { parseTripPlanningContextV1 } from '../../src/domain/trip/profile';
import type { TripChangeOperation } from './trip-change-intent-extractor';
import { TRIP_CHANGE_MAX_QUERY_LENGTH } from './trip-change-intent-extractor';
import {
  selectPlaceCandidate,
  type PlaceSearchService,
} from './trip-place-resolver';
import { hasExplicitTravelPreferences, type TripPlanPlaceCategory } from './trip-plan-generator';
import type { TripRouteEnricher } from './trip-route-enricher';
import { isFiniteGeoPoint } from './trip-route-enricher';
import { scheduleEnrichedTripDay, TripTimeScheduleError } from './trip-time-scheduler';
import { normalizeTripChangePlaceName } from './trip-change-intent-extractor';

const STABLE_PLACE_ID = /^(amap|mock):[A-Za-z0-9_-]{1,64}$/;

export type TripChangeExecutionErrorCode =
  | 'INVALID_REQUEST'
  | 'TRIP_CHANGE_INCOMPLETE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE';

export const TRIP_CHANGE_INVALID_REQUEST_MESSAGE = '行程修改请求无效，请调整后重试。';
export const TRIP_CHANGE_INCOMPLETE_MESSAGE = '暂时无法完成这次行程修改，请换一个地点后重试。';
export const TRIP_CHANGE_PROVIDER_ERROR_MESSAGE = '地点或路线服务暂时不可用，请稍后重试。';
export const TRIP_CHANGE_PROVIDER_UNAVAILABLE_MESSAGE = '地点或路线服务尚未配置。';
export const TRIP_CHANGE_SEARCH_LIMIT = 5;

export class TripChangeExecutionError extends Error {
  readonly validationReason?: string;

  constructor(
    readonly code: TripChangeExecutionErrorCode,
    message: string,
    validationReason?: string,
  ) {
    super(message);
    this.name = 'TripChangeExecutionError';
    if (validationReason && /^[A-Z][A-Z0-9_]{0,63}$/.test(validationReason)) {
      this.validationReason = validationReason;
    }
  }
}

export type ReplacePlaceOperation = Extract<TripChangeOperation, { type: 'REPLACE_PLACE' }>;

export interface ExecuteReplacePlaceInput {
  trip: Trip;
  places: Place[];
  operation: ReplacePlaceOperation;
  updatedAt: string;
}

export interface ReplacePlaceSummary {
  type: 'REPLACE_PLACE';
  dayNumber: number;
  replacedTripPlaceId: string;
  previousPlaceName: string;
  nextPlaceName: string;
  routeRecalculated: boolean;
}

export interface ExecuteReplacePlaceResult {
  trip: Trip;
  places: Place[];
  summary: ReplacePlaceSummary;
}

export type SelectMealPlaceOperation = {
  type: 'SELECT_MEAL_PLACE';
  dayNumber: number;
  mealSlotId: string;
  placeId: string;
};

export interface ExecuteSelectMealPlaceInput {
  trip: Trip;
  places: Place[];
  operation: SelectMealPlaceOperation;
  updatedAt: string;
}

export interface SelectMealPlaceSummary {
  type: 'SELECT_MEAL_PLACE';
  dayNumber: number;
  mealSlotId: string;
  nextPlaceName: string;
  routeRecalculated: boolean;
}

export interface ExecuteSelectMealPlaceResult {
  trip: Trip;
  places: Place[];
  summary: SelectMealPlaceSummary;
}

export interface TripChangeExecutor {
  replacePlace(input: ExecuteReplacePlaceInput): Promise<ExecuteReplacePlaceResult>;
  selectMealPlace(input: ExecuteSelectMealPlaceInput): Promise<ExecuteSelectMealPlaceResult>;
}

export interface TripChangeClock {
  nowIso(): string;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PLACE_TYPES = new Set<TripPlaceType>([
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
]);
const TRANSPORT_MODES = new Set<TransportMode>(['walk', 'metro', 'taxi', 'bus', 'drive']);
const PACES = new Set(['relaxed', 'balanced', 'packed']);
const STATUSES = new Set(['PLANNING', 'READY', 'TRAVELLING', 'COMPLETED']);
const EXPERIENCE_TYPES = new Set<TripExperienceType>(['meal', 'walk', 'free_time', 'night', 'rest']);
const MAX_DAY_SCHEDULE_ITEMS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new TripChangeExecutionError('INVALID_REQUEST', TRIP_CHANGE_INVALID_REQUEST_MESSAGE);
}

function incomplete(validationReason?: string): never {
  throw new TripChangeExecutionError('TRIP_CHANGE_INCOMPLETE', TRIP_CHANGE_INCOMPLETE_MESSAGE, validationReason);
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

function readId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !ID_PATTERN.test(value)) {
    invalidRequest();
  }
  return value;
}

function readNonEmpty(value: unknown): string {
  if (typeof value !== 'string') {
    invalidRequest();
  }
  const text = value.trim();
  if (text === '') {
    invalidRequest();
  }
  return text;
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

function inferQueryCategory(query: string): TripPlanPlaceCategory {
  if (/咖啡/.test(query)) return 'coffee';
  if (/餐|美食|小吃|茶社|餐厅|饭店|餐馆/.test(query)) return 'food';
  if (/酒店|宾馆/.test(query)) return 'hotel';
  if (/商场|购物/.test(query)) return 'shopping';
  return 'sight';
}

function isStablePlaceId(value: string): boolean {
  return STABLE_PLACE_ID.test(value);
}

function diningPlaceFromCatalog(
  catalog: Map<string, Place>,
  placeId: string,
): Place | undefined {
  const selected = catalog.get(placeId);
  if (!selected) {
    return undefined;
  }
  if (selected.category !== 'restaurant' && selected.category !== 'cafe') {
    return undefined;
  }
  return clonePlace(selected);
}

async function resolvePlaceByStableId(input: {
  placeId: string;
  catalog: Map<string, Place>;
  placeSearch: PlaceSearchService;
}): Promise<Place | undefined> {
  const fromCatalog = input.catalog.get(input.placeId);
  if (fromCatalog) {
    return clonePlace(fromCatalog);
  }
  if (typeof input.placeSearch.getByProviderPlaceId !== 'function') {
    return undefined;
  }
  const providerPlaceId = input.placeId.slice(input.placeId.indexOf(':') + 1);
  try {
    const detailed = await input.placeSearch.getByProviderPlaceId(providerPlaceId);
    return detailed ? clonePlace(detailed) : undefined;
  } catch (error) {
    mapProviderError(error);
  }
}

async function resolveReplacementPlace(input: {
  query: string;
  catalog: Map<string, Place>;
  usedPlaceIds: ReadonlySet<string>;
  targetPlaceId: string;
  city: string;
  sameDayPlaces: Place[];
  placeSearch: PlaceSearchService;
}): Promise<Place | 'NO_MATCH' | 'DUPLICATE_MATCH'> {
  const query = input.query.trim();
  if (isStablePlaceId(query)) {
    const resolved = await resolvePlaceByStableId({
      placeId: query,
      catalog: input.catalog,
      placeSearch: input.placeSearch,
    });
    if (!resolved) {
      return 'NO_MATCH';
    }
    if (resolved.id === input.targetPlaceId || input.usedPlaceIds.has(resolved.id)) {
      return 'DUPLICATE_MATCH';
    }
    return resolved;
  }

  const normalizedQuery = normalizeTripChangePlaceName(query);
  const catalogExact = [...input.catalog.values()].find((place) => (
    normalizeTripChangePlaceName(place.name) === normalizedQuery
    && place.id !== input.targetPlaceId
    && !input.usedPlaceIds.has(place.id)
  ));
  if (catalogExact) {
    return clonePlace(catalogExact);
  }

  let searched: Place[];
  try {
    searched = await input.placeSearch.search({
      query,
      city: input.city,
      limit: TRIP_CHANGE_SEARCH_LIMIT,
    });
  } catch (error) {
    mapProviderError(error);
  }
  if (!Array.isArray(searched)) {
    mapProviderError(new AmapProviderError('PROVIDER_ERROR', TRIP_CHANGE_PROVIDER_ERROR_MESSAGE));
  }
  const exactFromSearch = searched.find((place) => (
    normalizeTripChangePlaceName(place.name) === normalizedQuery
    && place.id !== input.targetPlaceId
    && !input.usedPlaceIds.has(place.id)
  ));
  if (exactFromSearch) {
    return clonePlace(exactFromSearch);
  }
  return selectPlaceCandidate(
    searched.map((place) => clonePlace(place)),
    {
      name: query,
      query,
      category: inferQueryCategory(query),
      suggestedStartTime: '10:00',
      suggestedDurationMinutes: 90,
      reason: '行程修改候选地点。',
    },
    input.usedPlaceIds,
    {
      destination: input.city,
      sameDayPlaces: input.sameDayPlaces.map((item) => clonePlace(item)),
    },
  );
}

function readPlace(value: unknown): Place {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const id = readId(value.id);
  if (value.provider !== 'amap' && value.provider !== 'mock') {
    invalidRequest();
  }
  if (typeof value.category !== 'string' || !PLACE_TYPES.has(value.category as TripPlaceType)) {
    invalidRequest();
  }
  if (!isFiniteGeoPoint({ latitude: value.latitude, longitude: value.longitude })) {
    invalidRequest();
  }
  return {
    id,
    provider: value.provider,
    providerPlaceId: readNonEmpty(value.providerPlaceId),
    name: readNonEmpty(value.name),
    address: typeof value.address === 'string' ? value.address : invalidRequest(),
    latitude: value.latitude as number,
    longitude: value.longitude as number,
    category: value.category as TripPlaceType,
  };
}

function readTripPlace(value: unknown, day: { id: string; tripId: string }): TripPlace {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const id = readId(value.id);
  const dayId = readId(value.dayId);
  if (dayId !== day.id) {
    invalidRequest();
  }
  if (typeof value.order !== 'number' || !Number.isInteger(value.order) || value.order < 1) {
    invalidRequest();
  }
  if (typeof value.category === 'string') {
    invalidRequest();
  }
  if (typeof value.type !== 'string' || !PLACE_TYPES.has(value.type as TripPlaceType)) {
    invalidRequest();
  }
  if (typeof value.estimatedCost !== 'number' || !Number.isFinite(value.estimatedCost)) {
    invalidRequest();
  }
  const place: TripPlace = {
    id,
    dayId,
    order: value.order,
    placeId: readId(value.placeId),
    placeName: readNonEmpty(value.placeName),
    type: value.type as TripPlaceType,
    estimatedCost: value.estimatedCost,
  };
  if (value.startTime !== undefined) {
    if (typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
      invalidRequest();
    }
    place.startTime = value.startTime;
  }
  if (value.endTime !== undefined) {
    if (typeof value.endTime !== 'string' || !CLOCK_TIME.test(value.endTime)) {
      invalidRequest();
    }
    place.endTime = value.endTime;
  }
  if (value.durationMinutes !== undefined) {
    if (typeof value.durationMinutes !== 'number' || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1) {
      invalidRequest();
    }
    place.durationMinutes = value.durationMinutes;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') {
      invalidRequest();
    }
    place.description = value.description;
  }
  if (value.transportToNext !== undefined) {
    if (!isRecord(value.transportToNext)) {
      invalidRequest();
    }
    const transport = value.transportToNext;
    if (
      typeof transport.mode !== 'string'
      || !TRANSPORT_MODES.has(transport.mode as TransportMode)
      || typeof transport.durationMinutes !== 'number'
      || !Number.isFinite(transport.durationMinutes)
      || typeof transport.distanceMeters !== 'number'
      || !Number.isFinite(transport.distanceMeters)
    ) {
      invalidRequest();
    }
    place.transportToNext = {
      mode: transport.mode as TransportMode,
      durationMinutes: transport.durationMinutes,
      distanceMeters: transport.distanceMeters,
      ...(typeof transport.description === 'string' ? { description: transport.description } : {}),
    };
  }
  return place;
}

function readScheduleItem(value: unknown, placeIds: ReadonlySet<string>): TripScheduleItem {
  if (
    !isRecord(value) ||
    (value.kind !== 'place' &&
      value.kind !== 'meal' &&
      value.kind !== 'meal_slot' &&
      value.kind !== 'meal_place' &&
      value.kind !== 'rest' &&
      value.kind !== 'area_walk' &&
      value.kind !== 'hotel_return' &&
      value.kind !== 'experience')
  ) {
    invalidRequest();
  }
  if (typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
    invalidRequest();
  }
  if (typeof value.durationMinutes !== 'number' || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1) {
    invalidRequest();
  }
  if (value.kind === 'place' || value.kind === 'meal' || value.kind === 'meal_place') {
    const tripPlaceId = readId(value.tripPlaceId);
    if (!placeIds.has(tripPlaceId)) {
      invalidRequest();
    }
    if (value.kind === 'place') {
      return { kind: 'place', tripPlaceId, startTime: value.startTime, durationMinutes: value.durationMinutes };
    }
    if (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner') {
      invalidRequest();
    }
    if (value.kind === 'meal_place') {
      return {
        kind: 'meal_place',
        tripPlaceId,
        startTime: value.startTime,
        durationMinutes: value.durationMinutes,
        mealPeriod: value.mealPeriod,
      };
    }
    return {
      kind: 'meal',
      tripPlaceId,
      startTime: value.startTime,
      durationMinutes: value.durationMinutes,
      mealPeriod: value.mealPeriod,
    };
  }
  if (value.kind === 'meal_slot') {
    const areaTripPlaceId = readId(value.areaTripPlaceId);
    if (!placeIds.has(areaTripPlaceId) || (value.diningMode !== 'flexible' && value.diningMode !== 'self_managed')) {
      invalidRequest();
    }
    if (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner') {
      invalidRequest();
    }
    const item: TripScheduleItem = {
      kind: 'meal_slot',
      id: readId(value.id),
      mealPeriod: value.mealPeriod,
      startTime: value.startTime,
      durationMinutes: value.durationMinutes,
      areaTripPlaceId,
      diningMode: value.diningMode,
    };
    if (value.nextTripPlaceId !== undefined) {
      const nextTripPlaceId = readId(value.nextTripPlaceId);
      if (!placeIds.has(nextTripPlaceId)) {
        invalidRequest();
      }
      item.nextTripPlaceId = nextTripPlaceId;
    }
    return item;
  }
  if (value.kind === 'rest' || value.kind === 'hotel_return' || value.kind === 'area_walk') {
    return structuredClone(value) as TripScheduleItem;
  }
  if (value.kind !== 'experience') {
    invalidRequest();
  }
  if (typeof value.type !== 'string' || !EXPERIENCE_TYPES.has(value.type as TripExperienceType)) {
    invalidRequest();
  }
  return {
    kind: 'experience',
    id: readId(value.id),
    startTime: value.startTime,
    durationMinutes: value.durationMinutes,
    type: value.type as TripExperienceType,
    title: readNonEmpty(value.title),
    description: readNonEmpty(value.description),
  };
}

function parsePlacesCatalog(values: unknown): Map<string, Place> {
  if (!Array.isArray(values) || values.length === 0) {
    invalidRequest();
  }
  const catalog = new Map<string, Place>();
  for (const value of values) {
    const place = readPlace(value);
    if (catalog.has(place.id)) {
      invalidRequest();
    }
    catalog.set(place.id, clonePlace(place));
  }
  return catalog;
}

function parseTrip(value: unknown): Trip {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const id = readId(value.id);
  const userId = readId(value.userId);
  if (typeof value.pace !== 'string' || !PACES.has(value.pace)) {
    invalidRequest();
  }
  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) {
    invalidRequest();
  }
  if (value.currency !== 'CNY') {
    invalidRequest();
  }
  if (!Array.isArray(value.days) || value.days.length === 0) {
    invalidRequest();
  }
  if (!Array.isArray(value.routes)) {
    invalidRequest();
  }
  const tripPlaceIds = new Set<string>();
  const days: TripDay[] = value.days.map((dayValue, index) => {
    if (!isRecord(dayValue)) {
      invalidRequest();
    }
    const dayNumber = index + 1;
    if (dayValue.dayNumber !== dayNumber) {
      invalidRequest();
    }
    const dayId = readId(dayValue.id);
    if (readId(dayValue.tripId) !== id) {
      invalidRequest();
    }
    if (!Array.isArray(dayValue.places) || dayValue.places.length === 0) {
      invalidRequest();
    }
    const places = dayValue.places.map((placeValue, placeIndex) => {
      const place = readTripPlace(placeValue, { id: dayId, tripId: id });
      if (place.order !== placeIndex + 1 || tripPlaceIds.has(place.id)) {
        invalidRequest();
      }
      tripPlaceIds.add(place.id);
      return place;
    });
    const day: TripDay = {
      id: dayId,
      tripId: id,
      dayNumber,
      date: typeof dayValue.date === 'string' ? dayValue.date : invalidRequest(),
      places,
    };
    if (typeof dayValue.title === 'string' && dayValue.title.trim() !== '') {
      day.title = dayValue.title;
    }
    if (typeof dayValue.summary === 'string' && dayValue.summary.trim() !== '') {
      day.summary = dayValue.summary;
    }
    if (dayValue.scheduleItems !== undefined) {
      if (!Array.isArray(dayValue.scheduleItems) || dayValue.scheduleItems.length > MAX_DAY_SCHEDULE_ITEMS) {
        invalidRequest();
      }
      const placeIds = new Set(places.map((place) => place.id));
      day.scheduleItems = dayValue.scheduleItems.map((item) => readScheduleItem(item, placeIds));
    }
    return day;
  });
  const routes: TripRoute[] = value.routes.map((routeValue) => {
    if (!isRecord(routeValue)) {
      invalidRequest();
    }
    const fromTripPlaceId = readId(routeValue.fromTripPlaceId);
    const toTripPlaceId = readId(routeValue.toTripPlaceId);
    if (!tripPlaceIds.has(fromTripPlaceId) || !tripPlaceIds.has(toTripPlaceId)) {
      invalidRequest();
    }
    if (!isRecord(routeValue.transport)) {
      invalidRequest();
    }
    if (
      typeof routeValue.transport.mode !== 'string'
      || !TRANSPORT_MODES.has(routeValue.transport.mode as TransportMode)
      || typeof routeValue.transport.durationMinutes !== 'number'
      || !Number.isFinite(routeValue.transport.durationMinutes)
      || typeof routeValue.transport.distanceMeters !== 'number'
      || !Number.isFinite(routeValue.transport.distanceMeters)
    ) {
      invalidRequest();
    }
    const route: TripRoute = {
      id: readId(routeValue.id),
      dayId: readId(routeValue.dayId),
      fromTripPlaceId,
      toTripPlaceId,
      transport: {
        mode: routeValue.transport.mode as TransportMode,
        durationMinutes: routeValue.transport.durationMinutes,
        distanceMeters: routeValue.transport.distanceMeters,
        ...(typeof routeValue.transport.description === 'string'
          ? { description: routeValue.transport.description }
          : {}),
      },
    };
    if (Array.isArray(routeValue.polyline)) {
      if (!routeValue.polyline.every((point) => isFiniteGeoPoint(point))) {
        invalidRequest();
      }
      route.polyline = routeValue.polyline.map((point) => ({
        latitude: (point as { latitude: number }).latitude,
        longitude: (point as { longitude: number }).longitude,
      }));
    }
    return route;
  });
  if (!isRecord(value.preferences) || !Array.isArray(value.preferences.interests)) {
    invalidRequest();
  }
  const trip: Trip = {
    id,
    userId,
    title: readNonEmpty(value.title),
    destination: readNonEmpty(value.destination),
    travelerCount: typeof value.travelerCount === 'number' ? value.travelerCount : invalidRequest(),
    totalBudget: typeof value.totalBudget === 'number' ? value.totalBudget : invalidRequest(),
    currency: 'CNY',
    pace: value.pace as Trip['pace'],
    preferences: {
      interests: value.preferences.interests.filter((item): item is string => typeof item === 'string'),
    },
    status: value.status as Trip['status'],
    days,
    routes,
    createdAt: typeof value.createdAt === 'string' && ISO_TIMESTAMP.test(value.createdAt)
      ? value.createdAt
      : invalidRequest(),
    updatedAt: typeof value.updatedAt === 'string' && ISO_TIMESTAMP.test(value.updatedAt)
      ? value.updatedAt
      : invalidRequest(),
  };
  if (typeof value.origin === 'string' && value.origin.trim() !== '') {
    trip.origin = value.origin;
  }
  if (typeof value.startDate === 'string') {
    trip.startDate = value.startDate;
  }
  if (typeof value.endDate === 'string') {
    trip.endDate = value.endDate;
  }
  if (value.planningContext !== undefined) {
    const planningContext = parseTripPlanningContextV1(value.planningContext);
    if (!planningContext) {
      invalidRequest();
    }
    trip.planningContext = planningContext;
  }
  return trip;
}

function parseOperation(value: unknown, trip: Trip): ReplacePlaceOperation {
  if (!isRecord(value) || value.type !== 'REPLACE_PLACE') {
    invalidRequest();
  }
  if (typeof value.dayNumber !== 'number' || !Number.isInteger(value.dayNumber)) {
    invalidRequest();
  }
  const day = trip.days.find((item) => item.dayNumber === value.dayNumber);
  if (!day) {
    invalidRequest();
  }
  const targetTripPlaceId = readId(value.targetTripPlaceId);
  const onDay = day.places.some((place) => place.id === targetTripPlaceId);
  const elsewhere = trip.days.some((item) => (
    item.dayNumber !== value.dayNumber && item.places.some((place) => place.id === targetTripPlaceId)
  ));
  if (!onDay || elsewhere) {
    invalidRequest();
  }
  if (typeof value.replacementQuery !== 'string') {
    invalidRequest();
  }
  const replacementQuery = value.replacementQuery.trim();
  if (replacementQuery === '' || replacementQuery.length > TRIP_CHANGE_MAX_QUERY_LENGTH) {
    invalidRequest();
  }
  return {
    type: 'REPLACE_PLACE',
    dayNumber: value.dayNumber,
    targetTripPlaceId,
    replacementQuery,
  };
}

function assertCatalogCoversTrip(trip: Trip, catalog: Map<string, Place>): void {
  const used = new Set<string>();
  for (const day of trip.days) {
    for (const place of day.places) {
      if (!catalog.has(place.placeId) || used.has(place.id)) {
        invalidRequest();
      }
      used.add(place.id);
    }
  }
}

function collectUsedPlaceIds(trip: Trip, exceptTripPlaceId: string): Set<string> {
  const used = new Set<string>();
  for (const day of trip.days) {
    for (const place of day.places) {
      if (place.id !== exceptTripPlaceId) {
        used.add(place.placeId);
      }
    }
  }
  return used;
}

function collectOutputPlaces(trip: Trip, catalog: Map<string, Place>): Place[] {
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const day of trip.days) {
    for (const stop of day.places) {
      if (seen.has(stop.placeId)) {
        continue;
      }
      const place = catalog.get(stop.placeId);
      if (!place) {
        invalidRequest();
      }
      seen.add(stop.placeId);
      places.push(clonePlace(place));
    }
  }
  return places;
}

function mapProviderError(error: unknown): never {
  if (error instanceof TripChangeExecutionError) {
    throw error;
  }
  if (error instanceof AmapProviderError) {
    if (error.code === 'PROVIDER_UNAVAILABLE') {
      throw new TripChangeExecutionError('PROVIDER_UNAVAILABLE', TRIP_CHANGE_PROVIDER_UNAVAILABLE_MESSAGE);
    }
    if (error.code === 'INVALID_REQUEST') {
      invalidRequest();
    }
    throw new TripChangeExecutionError('PROVIDER_ERROR', TRIP_CHANGE_PROVIDER_ERROR_MESSAGE);
  }
  throw new TripChangeExecutionError('PROVIDER_ERROR', TRIP_CHANGE_PROVIDER_ERROR_MESSAGE);
}

function stopDuration(place: TripPlace): number {
  return place.durationMinutes && place.durationMinutes >= 1 ? place.durationMinutes : 90;
}

function stopStartTime(place: TripPlace, targetTripPlaceId: string): string {
  if (place.id === targetTripPlaceId) {
    return '10:00';
  }
  return place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00';
}

function applyPlannedDaySchedule(trip: Trip, day: TripDay, diningMode: 'flexible' | 'arranged' | 'self_managed' = 'flexible'): void {
  const planned = planDaySchedule({
    dayId: day.id,
    destination: trip.destination,
    pace: trip.pace,
    diningMode,
    places: day.places,
    dayNumber: day.dayNumber,
    dayTitle: day.title,
    planningPolicy: trip.planningContext
      ? planningPolicyFromTripContext({
        pace: trip.pace,
        planningContext: trip.planningContext,
      })
      : undefined,
  });
  day.scheduleItems = planned.items;
  const byId = new Map(planned.places.map((place) => [place.id, place]));
  for (const place of day.places) {
    const next = byId.get(place.id);
    if (next?.startTime) {
      place.startTime = next.startTime;
    }
    if (typeof next?.durationMinutes === 'number') {
      place.durationMinutes = next.durationMinutes;
    }
  }
}

async function completeDayCorePlaces(input: {
  trip: Trip;
  day: TripDay;
  catalog: Map<string, Place>;
  placeSearch: PlaceSearchService;
}): Promise<void> {
  const stops = input.day.places.map((place) => {
    const mapped = input.catalog.get(place.placeId);
    if (!mapped) {
      invalidRequest();
    }
    return {
      place: clonePlace(mapped),
      category: planCategoryFromPlace(mapped.category),
      suggestedStartTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
      suggestedDurationMinutes: stopDuration(place),
      reason: place.description?.trim() || '行程地点。',
      sourceQuery: place.placeName,
    };
  });
  const completed = await completeResolvedTripCorePlaces({
    plan: {
      title: input.trip.title,
      summary: input.day.summary ?? '行程更新。',
      unresolved: [],
      days: [{
        dayNumber: input.day.dayNumber,
        title: input.day.title ?? '当日行程',
        summary: input.day.summary ?? '行程更新。',
        stops,
      }],
    },
    destination: input.trip.destination,
    pace: input.trip.pace,
    policy: planningPolicyFromTripContext({
      pace: input.trip.pace,
      planningContext: input.trip.planningContext,
    }),
    placeSearch: input.placeSearch,
    hasExplicitTravelPreferences: hasExplicitTravelPreferences({ preferences: input.trip.preferences }),
    preferenceTerms: [
      ...(input.trip.preferences?.interests ?? []),
      ...(input.trip.preferences?.mustVisit ?? []),
    ],
  });
  const done = completed.days[0];
  if (!done) {
    incomplete();
  }
  const previousByPlaceId = new Map(input.day.places.map((place) => [place.placeId, place]));
  input.day.places = done.stops.map((stop, index) => {
    input.catalog.set(stop.place.id, clonePlace(stop.place));
    const previous = previousByPlaceId.get(stop.place.id);
    return {
      id: previous?.id ?? `${input.day.id}:place:${stop.place.id}`,
      dayId: input.day.id,
      order: index + 1,
      placeId: stop.place.id,
      placeName: stop.place.name,
      type: stop.place.category,
      startTime: stop.suggestedStartTime,
      durationMinutes: stop.suggestedDurationMinutes,
      description: stop.reason,
      estimatedCost: 0,
    };
  });
  if (dayNeedsCorePlaceCompletion(
    done,
    input.trip.pace,
    planningPolicyFromTripContext({
      pace: input.trip.pace,
      planningContext: input.trip.planningContext,
    }).targetCorePlacesPerDay,
  )) {
    incomplete('MISSING_CORE_PLACES');
  }
}

export class AmapTripChangeExecutor implements TripChangeExecutor {
  constructor(
    private readonly placeSearch: PlaceSearchService,
    private readonly routeEnricher: TripRouteEnricher,
  ) {}

  async replacePlace(input: ExecuteReplacePlaceInput): Promise<ExecuteReplacePlaceResult> {
    if (!isRecord(input) || typeof input.updatedAt !== 'string' || !ISO_TIMESTAMP.test(input.updatedAt)) {
      invalidRequest();
    }
    const trip = parseTrip(input.trip);
    const catalog = parsePlacesCatalog(input.places);
    assertCatalogCoversTrip(trip, catalog);
    const operation = parseOperation(input.operation, trip);
    const day = trip.days.find((item) => item.dayNumber === operation.dayNumber);
    if (!day) {
      invalidRequest();
    }
    const target = day.places.find((place) => place.id === operation.targetTripPlaceId);
    if (!target) {
      invalidRequest();
    }
    const previousPlaceName = target.placeName;
    const usedPlaceIds = collectUsedPlaceIds(trip, target.id);
    usedPlaceIds.add(target.placeId);

    const selected = await resolveReplacementPlace({
      query: operation.replacementQuery,
      catalog,
      usedPlaceIds,
      targetPlaceId: target.placeId,
      city: trip.destination,
      sameDayPlaces: day.places
        .filter((item) => item.id !== target.id)
        .map((item) => catalog.get(item.placeId))
        .filter((item): item is Place => item !== undefined),
      placeSearch: this.placeSearch,
    });
    if (selected === 'NO_MATCH' || selected === 'DUPLICATE_MATCH') {
      incomplete(selected === 'DUPLICATE_MATCH' ? 'DUPLICATE_MATCH' : 'NO_MATCH');
    }
    if (selected.id === target.placeId || usedPlaceIds.has(selected.id)) {
      incomplete('DUPLICATE_MATCH');
    }

    const nextTrip = structuredClone(trip);
    const nextDay = nextTrip.days.find((item) => item.dayNumber === operation.dayNumber);
    if (!nextDay) {
      invalidRequest();
    }
    const nextTarget = nextDay.places.find((place) => place.id === operation.targetTripPlaceId);
    if (!nextTarget) {
      invalidRequest();
    }
    nextTarget.placeId = selected.id;
    nextTarget.placeName = selected.name;
    nextTarget.type = selected.category;
    delete nextTarget.transportToNext;
    nextTrip.updatedAt = input.updatedAt;
    catalog.set(selected.id, clonePlace(selected));

    await completeDayCorePlaces({
      trip: nextTrip,
      day: nextDay,
      catalog,
      placeSearch: this.placeSearch,
    });

    const routeRecalculated = nextDay.places.length >= 2;
    if (routeRecalculated) {
      const stops = nextDay.places.map((place) => {
        const mapped = catalog.get(place.placeId);
        if (!mapped) {
          invalidRequest();
        }
        return {
          place: clonePlace(mapped),
          category: planCategoryFromPlace(mapped.category),
          suggestedStartTime: stopStartTime(place, operation.targetTripPlaceId),
          suggestedDurationMinutes: stopDuration(place),
          reason: place.description?.trim() || '行程地点。',
          sourceQuery: place.id === target.id ? operation.replacementQuery : place.placeName,
        };
      });
      try {
        const enriched = await this.routeEnricher.enrich({
          plan: {
            title: nextTrip.title,
            summary: nextDay.summary ?? '行程更新。',
            unresolved: [],
            days: [{
              dayNumber: 1,
              title: nextDay.title ?? '当日行程',
              summary: nextDay.summary ?? '行程更新。',
              stops,
            }],
          },
          pace: nextTrip.pace,
        });
        const rebuilt = enriched.days[0]?.routes ?? [];
        nextTrip.routes = [
          ...nextTrip.routes.filter((route) => route.dayId !== nextDay.id),
          ...rebuilt.map((route, index) => {
            const fromStop = nextDay.places.find((place) => place.placeId === route.fromPlaceId);
            const toStop = nextDay.places.find((place) => place.placeId === route.toPlaceId);
            if (!fromStop || !toStop) {
              invalidRequest();
            }
            return {
              id: `${nextTrip.id}:day:${nextDay.dayNumber}:route:${index + 1}`,
              dayId: nextDay.id,
              fromTripPlaceId: fromStop.id,
              toTripPlaceId: toStop.id,
              transport: {
                mode: route.transport.mode,
                durationMinutes: route.transport.durationMinutes,
                distanceMeters: route.transport.distanceMeters,
                ...(route.transport.description !== undefined
                  ? { description: route.transport.description }
                  : {}),
              },
              polyline: route.polyline.map((point) => ({
                latitude: point.latitude,
                longitude: point.longitude,
              })),
            };
          }),
        ];
        const nextByFrom = new Map(rebuilt.map((route) => [route.fromPlaceId, route]));
        for (const place of nextDay.places) {
          const nextRoute = nextByFrom.get(place.placeId);
          if (nextRoute) {
            place.transportToNext = {
              mode: nextRoute.transport.mode,
              durationMinutes: nextRoute.transport.durationMinutes,
              distanceMeters: nextRoute.transport.distanceMeters,
              ...(nextRoute.transport.description !== undefined
                ? { description: nextRoute.transport.description }
                : {}),
            };
          } else {
            delete place.transportToNext;
          }
        }
      } catch (error) {
        if (error instanceof AmapProviderError && error.code === 'INVALID_REQUEST') {
          invalidRequest();
        }
        if (
          error instanceof AmapProviderError
          && (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_UNAVAILABLE')
        ) {
          nextTrip.routes = nextTrip.routes.filter((route) => route.dayId !== nextDay.id);
          for (const place of nextDay.places) {
            delete place.transportToNext;
          }
        } else {
          mapProviderError(error);
        }
      }
    }

    const scheduledStops = nextDay.places.map((place) => {
      const mapped = catalog.get(place.placeId);
      if (!mapped) {
        invalidRequest();
      }
      return {
        place: clonePlace(mapped),
        category: planCategoryFromPlace(mapped.category),
        suggestedStartTime: stopStartTime(place, operation.targetTripPlaceId),
        suggestedDurationMinutes: stopDuration(place),
        reason: place.description?.trim() || '行程地点。',
        sourceQuery: place.placeName,
      };
    });
    const dayRoutes = nextTrip.routes
      .filter((route) => route.dayId === nextDay.id)
      .flatMap((route) => {
        const from = nextDay.places.find((place) => place.id === route.fromTripPlaceId);
        const to = nextDay.places.find((place) => place.id === route.toTripPlaceId);
        if (!from || !to) {
          return [];
        }
        return [{
          fromPlaceId: from.placeId,
          toPlaceId: to.placeId,
          transport: {
            mode: route.transport.mode,
            durationMinutes: route.transport.durationMinutes,
            distanceMeters: route.transport.distanceMeters,
            ...(route.transport.description !== undefined
              ? { description: route.transport.description }
              : {}),
          },
          polyline: (route.polyline ?? []).map((point) => ({
            latitude: point.latitude,
            longitude: point.longitude,
          })),
        }];
      });
    try {
      const scheduled = scheduleEnrichedTripDay({
        dayNumber: nextDay.dayNumber,
        title: nextDay.title ?? '当日行程',
        summary: nextDay.summary ?? '行程更新。',
        stops: scheduledStops,
        routes: dayRoutes,
        unresolvedRoutes: [],
      });
      scheduled.stops.forEach((stop, index) => {
        nextDay.places[index].startTime = stop.suggestedStartTime;
      });
    } catch (error) {
      if (error instanceof TripTimeScheduleError) {
        invalidRequest();
      }
      throw error;
    }

    try {
      const completed = await completeEnrichedTripPlan({
        plan: {
          title: nextTrip.title,
          summary: nextDay.summary ?? '行程更新。',
          unresolved: [],
          days: [{
            dayNumber: nextDay.dayNumber,
            title: nextDay.title ?? '当日行程',
            summary: nextDay.summary ?? '行程更新。',
            stops: nextDay.places.map((place) => {
              const mapped = catalog.get(place.placeId);
              if (!mapped) {
                invalidRequest();
              }
              return {
                place: clonePlace(mapped),
                category: planCategoryFromPlace(mapped.category),
                suggestedStartTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
                suggestedDurationMinutes: stopDuration(place),
                reason: place.description?.trim() || '行程地点。',
                sourceQuery: place.placeName,
              };
            }),
            routes: dayRoutes,
            unresolvedRoutes: [],
          }],
        },
        destination: nextTrip.destination,
        pace: nextTrip.pace,
        diningMode: 'flexible',
        placeSearch: this.placeSearch,
        routeEnricher: this.routeEnricher,
      });
      const done = completed.days[0];
      if (!done) {
        incomplete();
      }
      const previousByPlaceId = new Map(nextDay.places.map((place) => [place.placeId, place]));
      nextDay.places = done.stops.map((stop, index) => {
        catalog.set(stop.place.id, clonePlace(stop.place));
        const previous = previousByPlaceId.get(stop.place.id);
        const nextRoute = done.routes.find((route) => route.fromPlaceId === stop.place.id);
        const tripPlace: TripPlace = {
          id: previous?.id ?? `${nextDay.id}:place:${stop.place.id}`,
          dayId: nextDay.id,
          order: index + 1,
          placeId: stop.place.id,
          placeName: stop.place.name,
          type: stop.place.category,
          startTime: stop.suggestedStartTime,
          durationMinutes: stop.suggestedDurationMinutes,
          description: stop.reason,
          estimatedCost: 0,
        };
        if (nextRoute) {
          tripPlace.transportToNext = {
            mode: nextRoute.transport.mode,
            durationMinutes: nextRoute.transport.durationMinutes,
            distanceMeters: nextRoute.transport.distanceMeters,
            ...(nextRoute.transport.description !== undefined
              ? { description: nextRoute.transport.description }
              : {}),
          };
        }
        return tripPlace;
      });
      nextTrip.routes = [
        ...nextTrip.routes.filter((route) => route.dayId !== nextDay.id),
        ...done.routes.map((route, index) => {
          const fromStop = nextDay.places.find((place) => place.placeId === route.fromPlaceId);
          const toStop = nextDay.places.find((place) => place.placeId === route.toPlaceId);
          if (!fromStop || !toStop) {
            invalidRequest();
          }
          return {
            id: `${nextTrip.id}:day:${nextDay.dayNumber}:route:${index + 1}`,
            dayId: nextDay.id,
            fromTripPlaceId: fromStop.id,
            toTripPlaceId: toStop.id,
            transport: {
              mode: route.transport.mode,
              durationMinutes: route.transport.durationMinutes,
              distanceMeters: route.transport.distanceMeters,
              ...(route.transport.description !== undefined
                ? { description: route.transport.description }
                : {}),
            },
            polyline: route.polyline.map((point) => ({
              latitude: point.latitude,
              longitude: point.longitude,
            })),
          };
        }),
      ];
    } catch (error) {
      if (error instanceof TripChangeExecutionError) {
        throw error;
      }
      mapProviderError(error);
    }

    nextDay.scheduleItems = undefined;
    applyPlannedDaySchedule(nextTrip, nextDay, 'flexible');
    const completeness = validateDayItineraryCompleteness({
      pace: nextTrip.pace,
      targetCorePlacesPerDay: planningPolicyFromTripContext({
        pace: nextTrip.pace,
        planningContext: nextTrip.planningContext,
      }).targetCorePlacesPerDay,
      placeIds: new Set(nextDay.places.map((place) => place.id)),
      corePlaceCount: nextDay.places.filter((place) => isCoreTripPlace(place)).length,
      items: nextDay.scheduleItems ?? [],
      places: nextDay.places,
    });
    if (!completeness.valid) {
      incomplete(completeness.reason);
    }

    return {
      trip: nextTrip,
      places: collectOutputPlaces(nextTrip, catalog),
      summary: {
        type: 'REPLACE_PLACE',
        dayNumber: operation.dayNumber,
        replacedTripPlaceId: target.id,
        previousPlaceName,
        nextPlaceName: selected.name,
        routeRecalculated,
      },
    };
  }

  async selectMealPlace(input: ExecuteSelectMealPlaceInput): Promise<ExecuteSelectMealPlaceResult> {
    if (!isRecord(input) || typeof input.updatedAt !== 'string' || !ISO_TIMESTAMP.test(input.updatedAt)) {
      invalidRequest();
    }
    const trip = parseTrip(input.trip);
    const catalog = parsePlacesCatalog(input.places);
    assertCatalogCoversTrip(trip, catalog);
    const operation = input.operation;
    if (
      !isRecord(operation)
      || operation.type !== 'SELECT_MEAL_PLACE'
      || typeof operation.dayNumber !== 'number'
      || !Number.isInteger(operation.dayNumber)
      || typeof operation.mealSlotId !== 'string'
      || typeof operation.placeId !== 'string'
    ) {
      invalidRequest();
    }
    const day = trip.days.find((item) => item.dayNumber === operation.dayNumber);
    if (!day?.scheduleItems) {
      invalidRequest();
    }
    const slot = day.scheduleItems.find((item) => item.kind === 'meal_slot' && item.id === operation.mealSlotId);
    if (!slot || slot.kind !== 'meal_slot' || slot.diningMode !== 'flexible') {
      invalidRequest();
    }
    const areaStop = day.places.find((place) => place.id === slot.areaTripPlaceId);
    const areaPlace = areaStop ? catalog.get(areaStop.placeId) : undefined;
    if (!areaPlace) {
      invalidRequest();
    }
    const nextStop = slot.nextTripPlaceId
      ? day.places.find((place) => place.id === slot.nextTripPlaceId)
      : undefined;
    const nextPlace = nextStop ? catalog.get(nextStop.placeId) : undefined;
    let selected = diningPlaceFromCatalog(catalog, operation.placeId);
    if (!selected && isStablePlaceId(operation.placeId)) {
      const byId = await resolvePlaceByStableId({
        placeId: operation.placeId,
        catalog,
        placeSearch: this.placeSearch,
      });
      if (byId && (byId.category === 'restaurant' || byId.category === 'cafe')) {
        selected = byId;
      } else if (byId) {
        incomplete('MEAL_CANDIDATE_UNAVAILABLE');
      }
    }
    if (!selected) {
      let candidates: Place[] = [];
      try {
        const nearbyName = areaPlace.name.includes('附近') ? areaPlace.name : `${areaPlace.name}附近`;
        const nearby = await searchMealDiningPlaces({
          city: trip.destination,
          mealPeriod: slot.mealPeriod,
          area: {
            ...areaPlace,
            name: nearbyName,
          },
          ...(nextPlace ? { nextPlace } : {}),
          placeSearch: this.placeSearch,
        });
        const selectedNearby = nearby.find((place) => place.id === operation.placeId);
        if (selectedNearby) {
          candidates = nearby;
        } else {
          const fallback = await searchMealDiningPlaces({
            city: trip.destination,
            mealPeriod: slot.mealPeriod,
            area: areaPlace,
            ...(nextPlace ? { nextPlace } : {}),
            placeSearch: this.placeSearch,
          });
          const seen = new Set(nearby.map((place) => place.id));
          candidates = [...nearby, ...fallback.filter((place) => !seen.has(place.id))];
        }
      } catch (error) {
        mapProviderError(error);
      }
      const matched = candidates.find((place) => place.id === operation.placeId);
      if (matched) {
        selected = clonePlace(matched);
      }
    }
    if (!selected || (selected.category !== 'restaurant' && selected.category !== 'cafe')) {
      incomplete('MEAL_CANDIDATE_UNAVAILABLE');
    }
    if (collectUsedPlaceIds(trip, '').has(selected.id)) {
      incomplete('MEAL_CANDIDATE_UNAVAILABLE');
    }

    const nextTrip = structuredClone(trip);
    const nextDay = nextTrip.days.find((item) => item.dayNumber === operation.dayNumber);
    if (!nextDay) {
      invalidRequest();
    }
    const insertAt = nextDay.places.findIndex((place) => place.id === slot.areaTripPlaceId) + 1;
    if (insertAt < 1) {
      invalidRequest();
    }
    const mealTripPlace: TripPlace = {
      id: `${nextDay.id}:meal:${slot.mealPeriod}`,
      dayId: nextDay.id,
      order: insertAt + 1,
      placeId: selected.id,
      placeName: selected.name,
      type: selected.category,
      startTime: slot.startTime,
      durationMinutes: slot.durationMinutes,
      description: slot.mealPeriod === 'lunch' ? '午餐安排。' : '晚餐安排。',
      estimatedCost: 0,
    };
    nextDay.places.splice(insertAt, 0, mealTripPlace);
    nextDay.places.forEach((place, index) => {
      place.order = index + 1;
    });
    nextTrip.updatedAt = input.updatedAt;
    catalog.set(selected.id, clonePlace(selected));

    const routeRecalculated = nextDay.places.length >= 2;
    if (routeRecalculated) {
      const stops = nextDay.places.map((place) => {
        const mapped = catalog.get(place.placeId);
        if (!mapped) {
          invalidRequest();
        }
        return {
          place: clonePlace(mapped),
          category: planCategoryFromPlace(mapped.category),
          suggestedStartTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
          suggestedDurationMinutes: stopDuration(place),
          reason: place.description?.trim() || '行程地点。',
          sourceQuery: place.placeName,
        };
      });
      try {
        const enriched = await this.routeEnricher.enrich({
          plan: {
            title: nextTrip.title,
            summary: nextDay.summary ?? '行程更新。',
            unresolved: [],
            days: [{
              dayNumber: 1,
              title: nextDay.title ?? '当日行程',
              summary: nextDay.summary ?? '行程更新。',
              stops,
            }],
          },
          pace: nextTrip.pace,
        });
        const rebuilt = enriched.days[0]?.routes ?? [];
        nextTrip.routes = [
          ...nextTrip.routes.filter((route) => route.dayId !== nextDay.id),
          ...rebuilt.map((route, index) => {
            const fromStop = nextDay.places.find((place) => place.placeId === route.fromPlaceId);
            const toStop = nextDay.places.find((place) => place.placeId === route.toPlaceId);
            if (!fromStop || !toStop) {
              invalidRequest();
            }
            return {
              id: `${nextTrip.id}:day:${nextDay.dayNumber}:route:${index + 1}`,
              dayId: nextDay.id,
              fromTripPlaceId: fromStop.id,
              toTripPlaceId: toStop.id,
              transport: {
                mode: route.transport.mode,
                durationMinutes: route.transport.durationMinutes,
                distanceMeters: route.transport.distanceMeters,
                ...(route.transport.description !== undefined
                  ? { description: route.transport.description }
                  : {}),
              },
              polyline: route.polyline.map((point) => ({
                latitude: point.latitude,
                longitude: point.longitude,
              })),
            };
          }),
        ];
        nextDay.places.forEach((place) => {
          delete place.transportToNext;
        });
        for (const route of nextTrip.routes.filter((item) => item.dayId === nextDay.id)) {
          const from = nextDay.places.find((place) => place.id === route.fromTripPlaceId);
          if (from) {
            from.transportToNext = {
              mode: route.transport.mode,
              durationMinutes: route.transport.durationMinutes,
              distanceMeters: route.transport.distanceMeters,
              ...(route.transport.description !== undefined
                ? { description: route.transport.description }
                : {}),
            };
          }
        }
      } catch (error) {
        mapProviderError(error);
      }

      const dayRoutes = nextTrip.routes
        .filter((route) => route.dayId === nextDay.id)
        .flatMap((route) => {
          const from = nextDay.places.find((place) => place.id === route.fromTripPlaceId);
          const to = nextDay.places.find((place) => place.id === route.toTripPlaceId);
          if (!from || !to) {
            return [];
          }
          return [{
            fromPlaceId: from.placeId,
            toPlaceId: to.placeId,
            transport: {
              mode: route.transport.mode,
              durationMinutes: route.transport.durationMinutes,
              distanceMeters: route.transport.distanceMeters,
              ...(route.transport.description !== undefined
                ? { description: route.transport.description }
                : {}),
            },
            polyline: (route.polyline ?? []).map((point) => ({
              latitude: point.latitude,
              longitude: point.longitude,
            })),
          }];
        });
      try {
        const scheduled = scheduleEnrichedTripDay({
          dayNumber: nextDay.dayNumber,
          title: nextDay.title ?? '当日行程',
          summary: nextDay.summary ?? '行程更新。',
          stops: nextDay.places.map((place) => {
            const mapped = catalog.get(place.placeId);
            if (!mapped) {
              invalidRequest();
            }
            return {
              place: clonePlace(mapped),
              category: planCategoryFromPlace(mapped.category),
              suggestedStartTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
              suggestedDurationMinutes: stopDuration(place),
              reason: place.description?.trim() || '行程地点。',
              sourceQuery: place.placeName,
            };
          }),
          routes: dayRoutes,
          unresolvedRoutes: [],
        });
        scheduled.stops.forEach((stop, index) => {
          nextDay.places[index].startTime = stop.suggestedStartTime;
        });
      } catch (error) {
        if (error instanceof TripTimeScheduleError) {
          invalidRequest();
        }
        throw error;
      }

      try {
        const completed = await completeEnrichedTripPlan({
          plan: {
            title: nextTrip.title,
            summary: nextDay.summary ?? '行程更新。',
            unresolved: [],
            days: [{
              dayNumber: nextDay.dayNumber,
              title: nextDay.title ?? '当日行程',
              summary: nextDay.summary ?? '行程更新。',
              stops: nextDay.places.map((place) => {
                const mapped = catalog.get(place.placeId);
                if (!mapped) {
                  invalidRequest();
                }
                return {
                  place: clonePlace(mapped),
                  category: planCategoryFromPlace(mapped.category),
                  suggestedStartTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
                  suggestedDurationMinutes: stopDuration(place),
                  reason: place.description?.trim() || '行程地点。',
                  sourceQuery: place.placeName,
                };
              }),
              routes: dayRoutes,
              unresolvedRoutes: [],
            }],
          },
          destination: nextTrip.destination,
          pace: nextTrip.pace,
          diningMode: 'flexible',
          placeSearch: this.placeSearch,
          routeEnricher: this.routeEnricher,
        });
        const done = completed.days[0];
        if (!done) {
          incomplete();
        }
        const previousByPlaceId = new Map(nextDay.places.map((place) => [place.placeId, place]));
        nextDay.places = done.stops.map((stop, index) => {
          catalog.set(stop.place.id, clonePlace(stop.place));
          const previous = previousByPlaceId.get(stop.place.id);
          const nextRoute = done.routes.find((route) => route.fromPlaceId === stop.place.id);
          const tripPlace: TripPlace = {
            id: previous?.id ?? `${nextDay.id}:place:${stop.place.id}`,
            dayId: nextDay.id,
            order: index + 1,
            placeId: stop.place.id,
            placeName: stop.place.name,
            type: stop.place.category,
            startTime: stop.suggestedStartTime,
            durationMinutes: stop.suggestedDurationMinutes,
            description: stop.reason,
            estimatedCost: 0,
          };
          if (nextRoute) {
            tripPlace.transportToNext = {
              mode: nextRoute.transport.mode,
              durationMinutes: nextRoute.transport.durationMinutes,
              distanceMeters: nextRoute.transport.distanceMeters,
              ...(nextRoute.transport.description !== undefined
                ? { description: nextRoute.transport.description }
                : {}),
            };
          }
          return tripPlace;
        });
        nextTrip.routes = [
          ...nextTrip.routes.filter((route) => route.dayId !== nextDay.id),
          ...done.routes.map((route, index) => {
            const fromStop = nextDay.places.find((place) => place.placeId === route.fromPlaceId);
            const toStop = nextDay.places.find((place) => place.placeId === route.toPlaceId);
            if (!fromStop || !toStop) {
              invalidRequest();
            }
            return {
              id: `${nextTrip.id}:day:${nextDay.dayNumber}:route:${index + 1}`,
              dayId: nextDay.id,
              fromTripPlaceId: fromStop.id,
              toTripPlaceId: toStop.id,
              transport: {
                mode: route.transport.mode,
                durationMinutes: route.transport.durationMinutes,
                distanceMeters: route.transport.distanceMeters,
                ...(route.transport.description !== undefined
                  ? { description: route.transport.description }
                  : {}),
              },
              polyline: route.polyline.map((point) => ({
                latitude: point.latitude,
                longitude: point.longitude,
              })),
            };
          }),
        ];
      } catch (error) {
        if (error instanceof TripChangeExecutionError) {
          throw error;
        }
        mapProviderError(error);
      }
    }

    nextDay.scheduleItems = undefined;
    applyPlannedDaySchedule(nextTrip, nextDay, 'flexible');
    const completeness = validateDayItineraryCompleteness({
      pace: nextTrip.pace,
      targetCorePlacesPerDay: planningPolicyFromTripContext({
        pace: nextTrip.pace,
        planningContext: nextTrip.planningContext,
      }).targetCorePlacesPerDay,
      placeIds: new Set(nextDay.places.map((place) => place.id)),
      corePlaceCount: nextDay.places.filter((place) => isCoreTripPlace(place)).length,
      items: nextDay.scheduleItems ?? [],
      places: nextDay.places,
    });
    if (!completeness.valid) {
      incomplete(completeness.reason);
    }

    return {
      trip: nextTrip,
      places: collectOutputPlaces(nextTrip, catalog),
      summary: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: operation.dayNumber,
        mealSlotId: operation.mealSlotId,
        nextPlaceName: selected.name,
        routeRecalculated,
      },
    };
  }
}

export type { PlaceSearchService };
