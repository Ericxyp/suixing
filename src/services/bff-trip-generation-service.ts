import type {
  Currency,
  GeoPoint,
  Place,
  PlaceProviderName,
  TransportMode,
  TransportSegment,
  Trip,
  TripDay,
  TripExperienceType,
  TripPace,
  TripPlace,
  TripPlaceType,
  TripPreference,
  TripRoute,
  TripScheduleItem,
  TripStatus,
} from '../domain/trip/types';
import type { CreateTripInput } from '../repositories/trip-repository';
import {
  parsePartyContextV1,
  parseTravelProfileSignals,
  parseTripConstraintsV1,
  parseTripIntentV1,
  parseTripPlanningContextV1,
} from '../domain/trip/profile';
import {
  BffClientError,
  BffHttpClient,
  type FetchLike,
} from './bff-client';

export const TRIP_GENERATE_PATH = '/api/trips/generate';
export const DEFAULT_TRIP_GENERATION_TIMEOUT_MS = 115_000;

export interface TripGenerationDiagnostics {
  unresolvedPlacesCount: number;
  unresolvedRoutesCount: number;
}

export interface TripGenerationResult {
  trip: Trip;
  places: Place[];
  diagnostics: TripGenerationDiagnostics;
}

const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const STATUSES = new Set<TripStatus>(['PLANNING', 'READY', 'TRAVELLING', 'COMPLETED']);
const PACES = new Set<TripPace>(['relaxed', 'balanced', 'packed']);
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
const PLACE_PROVIDERS = new Set<PlaceProviderName>(['amap', 'mock']);
const PLACE_RECORD_KEYS = [
  'id',
  'provider',
  'providerPlaceId',
  'name',
  'address',
  'latitude',
  'longitude',
  'category',
] as const;
const PREFERENCE_KEYS = new Set(['interests', 'accommodation', 'mustVisit', 'avoid']);
const REQUIREMENT_KEYS = new Set([
  'destination',
  'origin',
  'startDate',
  'endDate',
  'durationDays',
  'travelerCount',
  'totalBudget',
  'pace',
  'preferences',
  'tripIntent',
  'partyContext',
  'constraints',
  'profileSignals',
]);
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const EXPERIENCE_TYPES = new Set<TripExperienceType>(['meal', 'walk', 'free_time', 'night', 'rest']);
const MAX_DAY_SCHEDULE_ITEMS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
}

function readString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalidResponse();
  }
  return value;
}

function readFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidResponse();
  }
  return value;
}

function readInteger(value: unknown): number {
  const number = readFiniteNumber(value);
  if (!Number.isInteger(number)) {
    invalidResponse();
  }
  return number;
}

function readNonNegativeInteger(value: unknown): number {
  const number = readInteger(value);
  if (number < 0) {
    invalidResponse();
  }
  return number;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value);
}

function readDayDate(value: unknown): string {
  if (typeof value !== 'string') {
    invalidResponse();
  }
  return value;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  return value.map((item) => readString(item));
}

function readPreferences(value: unknown): TripPreference {
  if (!isRecord(value)) {
    invalidResponse();
  }
  for (const key of Object.keys(value)) {
    if (!PREFERENCE_KEYS.has(key)) {
      invalidResponse();
    }
  }
  const preferences: TripPreference = {
    interests: readStringList(value.interests),
  };
  if (value.accommodation !== undefined) {
    preferences.accommodation = readStringList(value.accommodation);
  }
  if (value.mustVisit !== undefined) {
    preferences.mustVisit = readStringList(value.mustVisit);
  }
  if (value.avoid !== undefined) {
    preferences.avoid = readStringList(value.avoid);
  }
  return preferences;
}

function readTransport(value: unknown): TransportSegment {
  if (!isRecord(value)) {
    invalidResponse();
  }
  if (typeof value.mode !== 'string' || !TRANSPORT_MODES.has(value.mode as TransportMode)) {
    invalidResponse();
  }
  const transport: TransportSegment = {
    mode: value.mode as TransportMode,
    durationMinutes: readNonNegativeInteger(value.durationMinutes),
    distanceMeters: readNonNegativeInteger(value.distanceMeters),
  };
  const description = readOptionalString(value.description);
  if (description !== undefined) {
    transport.description = description;
  }
  return transport;
}

function readGeoPoint(value: unknown): GeoPoint {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const latitude = readFiniteNumber(value.latitude);
  const longitude = readFiniteNumber(value.longitude);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    invalidResponse();
  }
  return { latitude, longitude };
}

function readTripPlace(value: unknown): TripPlace {
  if (!isRecord(value)) {
    invalidResponse();
  }
  if (typeof value.type !== 'string' || !PLACE_TYPES.has(value.type as TripPlaceType)) {
    invalidResponse();
  }
  const place: TripPlace = {
    id: readString(value.id),
    dayId: readString(value.dayId),
    order: readInteger(value.order),
    placeId: readString(value.placeId),
    placeName: readString(value.placeName),
    type: value.type as TripPlaceType,
    estimatedCost: readFiniteNumber(value.estimatedCost),
  };
  const startTime = readOptionalString(value.startTime);
  const endTime = readOptionalString(value.endTime);
  if (startTime !== undefined) place.startTime = startTime;
  if (endTime !== undefined) place.endTime = endTime;
  if (value.durationMinutes !== undefined) {
    place.durationMinutes = readNonNegativeInteger(value.durationMinutes);
  }
  const description = readOptionalString(value.description);
  if (description !== undefined) place.description = description;
  if (value.transportToNext !== undefined) {
    place.transportToNext = readTransport(value.transportToNext);
  }
  return place;
}

function readScheduleItem(value: unknown, placeIds: ReadonlySet<string>): TripScheduleItem {
  if (!isRecord(value)) {
    invalidResponse();
  }
  if (typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
    invalidResponse();
  }
  const durationMinutes = readInteger(value.durationMinutes);
  if (durationMinutes < 1) {
    invalidResponse();
  }
  if (value.kind === 'place' || value.kind === 'meal' || value.kind === 'meal_place') {
    const tripPlaceId = readString(value.tripPlaceId);
    if (!placeIds.has(tripPlaceId)) {
      invalidResponse();
    }
    if (value.kind === 'place') {
      return { kind: 'place', tripPlaceId, startTime: value.startTime, durationMinutes };
    }
    if (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner') {
      invalidResponse();
    }
    if (value.kind === 'meal_place') {
      return {
        kind: 'meal_place',
        tripPlaceId,
        startTime: value.startTime,
        durationMinutes,
        mealPeriod: value.mealPeriod,
      };
    }
    return {
      kind: 'meal',
      tripPlaceId,
      startTime: value.startTime,
      durationMinutes,
      mealPeriod: value.mealPeriod,
    };
  }
  if (value.kind === 'meal_slot') {
    const areaTripPlaceId = readString(value.areaTripPlaceId);
    if (
      !placeIds.has(areaTripPlaceId)
      || (value.diningMode !== 'flexible' && value.diningMode !== 'self_managed')
      || (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner')
    ) {
      invalidResponse();
    }
    const item: Extract<TripScheduleItem, { kind: 'meal_slot' }> = {
      kind: 'meal_slot',
      id: readString(value.id),
      mealPeriod: value.mealPeriod,
      startTime: value.startTime,
      durationMinutes,
      areaTripPlaceId,
      diningMode: value.diningMode,
    };
    if (value.nextTripPlaceId !== undefined) {
      const nextTripPlaceId = readString(value.nextTripPlaceId);
      if (!placeIds.has(nextTripPlaceId)) {
        invalidResponse();
      }
      item.nextTripPlaceId = nextTripPlaceId;
    }
    return item;
  }
  if (value.kind === 'rest') {
    if (value.title !== '午间休息' && value.title !== '参观后休息') {
      invalidResponse();
    }
    return {
      kind: 'rest',
      id: readString(value.id),
      startTime: value.startTime,
      durationMinutes,
      title: value.title,
      description: readString(value.description),
    };
  }
  if (value.kind === 'hotel_return') {
    if (value.title !== '返程准备') {
      invalidResponse();
    }
    return {
      kind: 'hotel_return',
      id: readString(value.id),
      startTime: value.startTime,
      durationMinutes,
      title: '返程准备',
      description: readString(value.description),
    };
  }
  if (value.kind === 'area_walk') {
    if (!Array.isArray(value.optionTripPlaceIds)) {
      invalidResponse();
    }
    const areaTripPlaceId = readString(value.areaTripPlaceId);
    const optionTripPlaceIds = value.optionTripPlaceIds.map((item) => readString(item));
    if (!placeIds.has(areaTripPlaceId) || optionTripPlaceIds.some((id) => !placeIds.has(id))) {
      invalidResponse();
    }
    return {
      kind: 'area_walk',
      id: readString(value.id),
      startTime: value.startTime,
      durationMinutes,
      areaTripPlaceId,
      optionTripPlaceIds,
      title: readString(value.title),
      description: readString(value.description),
    };
  }
  if (value.kind !== 'experience') {
    invalidResponse();
  }
  if (typeof value.type !== 'string' || !EXPERIENCE_TYPES.has(value.type as TripExperienceType)) {
    invalidResponse();
  }
  return {
    kind: 'experience',
    id: readString(value.id),
    startTime: value.startTime,
    durationMinutes,
    type: value.type as TripExperienceType,
    title: readString(value.title),
    description: readString(value.description),
  };
}

function readTripDay(value: unknown): TripDay {
  if (!isRecord(value) || !Array.isArray(value.places)) {
    invalidResponse();
  }
  const day: TripDay = {
    id: readString(value.id),
    tripId: readString(value.tripId),
    dayNumber: readInteger(value.dayNumber),
    date: readDayDate(value.date),
    places: value.places.map((place) => readTripPlace(place)),
  };
  const title = readOptionalString(value.title);
  const summary = readOptionalString(value.summary);
  if (title !== undefined) day.title = title;
  if (summary !== undefined) day.summary = summary;
  if (value.scheduleItems !== undefined) {
    if (!Array.isArray(value.scheduleItems) || value.scheduleItems.length > MAX_DAY_SCHEDULE_ITEMS) {
      invalidResponse();
    }
    const placeIds = new Set(day.places.map((place) => place.id));
    day.scheduleItems = value.scheduleItems.map((item) => readScheduleItem(item, placeIds));
  }
  return day;
}

function readTripRoute(value: unknown): TripRoute {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const route: TripRoute = {
    id: readString(value.id),
    dayId: readString(value.dayId),
    fromTripPlaceId: readString(value.fromTripPlaceId),
    toTripPlaceId: readString(value.toTripPlaceId),
    transport: readTransport(value.transport),
  };
  if (value.polyline !== undefined) {
    if (!Array.isArray(value.polyline)) {
      invalidResponse();
    }
    route.polyline = value.polyline.map((point) => readGeoPoint(point));
  }
  return route;
}

function readTrip(value: unknown): Trip {
  if (!isRecord(value)) {
    invalidResponse();
  }
  if (typeof value.currency !== 'string' || value.currency !== 'CNY') {
    invalidResponse();
  }
  if (typeof value.pace !== 'string' || !PACES.has(value.pace as TripPace)) {
    invalidResponse();
  }
  if (typeof value.status !== 'string' || !STATUSES.has(value.status as TripStatus)) {
    invalidResponse();
  }
  if (!Array.isArray(value.days) || !Array.isArray(value.routes)) {
    invalidResponse();
  }
  const trip: Trip = {
    id: readString(value.id),
    userId: readString(value.userId),
    title: readString(value.title),
    destination: readString(value.destination),
    travelerCount: readInteger(value.travelerCount),
    totalBudget: readFiniteNumber(value.totalBudget),
    currency: value.currency as Currency,
    pace: value.pace as TripPace,
    preferences: readPreferences(value.preferences),
    status: value.status as TripStatus,
    days: value.days.map((day) => readTripDay(day)),
    routes: value.routes.map((route) => readTripRoute(route)),
    createdAt: readString(value.createdAt),
    updatedAt: readString(value.updatedAt),
  };
  const origin = readOptionalString(value.origin);
  const startDate = readOptionalString(value.startDate);
  const endDate = readOptionalString(value.endDate);
  if (origin !== undefined) trip.origin = origin;
  if (startDate !== undefined) trip.startDate = startDate;
  if (endDate !== undefined) trip.endDate = endDate;
  if (value.planningContext !== undefined) {
    const planningContext = parseTripPlanningContextV1(value.planningContext);
    if (!planningContext) {
      invalidResponse();
    }
    trip.planningContext = planningContext;
  }
  return trip;
}

function readInternalPlace(value: unknown): Place {
  if (!isRecord(value) || Object.keys(value).length !== PLACE_RECORD_KEYS.length) {
    invalidResponse();
  }
  for (const key of PLACE_RECORD_KEYS) {
    if (!(key in value)) {
      invalidResponse();
    }
  }
  if (typeof value.provider !== 'string' || !PLACE_PROVIDERS.has(value.provider as PlaceProviderName)) {
    invalidResponse();
  }
  if (typeof value.category !== 'string' || !PLACE_TYPES.has(value.category as TripPlaceType)) {
    invalidResponse();
  }
  const latitude = readFiniteNumber(value.latitude);
  const longitude = readFiniteNumber(value.longitude);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    invalidResponse();
  }
  return {
    id: readString(value.id),
    provider: value.provider as PlaceProviderName,
    providerPlaceId: readString(value.providerPlaceId),
    name: readString(value.name),
    address: readString(value.address),
    latitude,
    longitude,
    category: value.category as TripPlaceType,
  };
}

function referencedPlaceIds(trip: Trip): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const day of trip.days) {
    const ordered = [...day.places].sort((left, right) => left.order - right.order);
    for (const place of ordered) {
      if (seen.has(place.placeId)) {
        continue;
      }
      seen.add(place.placeId);
      ids.push(place.placeId);
    }
  }
  return ids;
}

function readPlaces(value: unknown, trip: Trip): Place[] {
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  const places = value.map((item) => readInternalPlace(item));
  const byId = new Map<string, Place>();
  for (const place of places) {
    if (byId.has(place.id)) {
      invalidResponse();
    }
    byId.set(place.id, place);
  }
  const referenced = referencedPlaceIds(trip);
  if (places.length !== referenced.length) {
    invalidResponse();
  }
  for (const placeId of referenced) {
    if (!byId.has(placeId)) {
      invalidResponse();
    }
  }
  return referenced.map((placeId) => byId.get(placeId)!);
}

function readDiagnostics(value: unknown): TripGenerationDiagnostics {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !('unresolvedPlacesCount' in value)
    || !('unresolvedRoutesCount' in value)
  ) {
    invalidResponse();
  }
  return {
    unresolvedPlacesCount: readNonNegativeInteger(value.unresolvedPlacesCount),
    unresolvedRoutesCount: readNonNegativeInteger(value.unresolvedRoutesCount),
  };
}

export function parseTripGenerationPayload(payload: unknown): TripGenerationResult {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    invalidResponse();
  }
  const keys = Object.keys(payload.data);
  if (
    keys.length !== 3
    || !('trip' in payload.data)
    || !('places' in payload.data)
    || !('diagnostics' in payload.data)
  ) {
    invalidResponse();
  }
  const trip = readTrip(payload.data.trip);
  return {
    trip,
    places: readPlaces(payload.data.places, trip),
    diagnostics: readDiagnostics(payload.data.diagnostics),
  };
}

export function parseInternalTrip(value: unknown): Trip {
  return readTrip(value);
}

export function parseInternalPlaces(value: unknown, trip: Trip): Place[] {
  return readPlaces(value, trip);
}

function inclusiveDayCount(startDate: string, endDate: string): number | undefined {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function toTripGenerationRequirement(
  requirements: CreateTripInput['requirements'],
): Record<string, unknown> | undefined {
  if (!isRecord(requirements)) {
    return undefined;
  }
  const durationDays = requirements.durationDays
    ?? (
      requirements.startDate && requirements.endDate
        ? inclusiveDayCount(requirements.startDate, requirements.endDate)
        : undefined
    );
  if (
    typeof requirements.destination !== 'string'
    || requirements.destination.trim() === ''
    || typeof durationDays !== 'number'
    || typeof requirements.travelerCount !== 'number'
    || typeof requirements.totalBudget !== 'number'
  ) {
    return undefined;
  }
  const requirement: Record<string, unknown> = {
    destination: requirements.destination.trim(),
    durationDays,
    travelerCount: requirements.travelerCount,
    totalBudget: requirements.totalBudget,
  };
  if (typeof requirements.origin === 'string' && requirements.origin.trim() !== '') {
    requirement.origin = requirements.origin;
  }
  if (typeof requirements.startDate === 'string') {
    requirement.startDate = requirements.startDate;
  }
  if (typeof requirements.endDate === 'string') {
    requirement.endDate = requirements.endDate;
  }
  if (requirements.pace) {
    requirement.pace = requirements.pace;
  }
  if (requirements.preferences) {
    requirement.preferences = structuredClone(requirements.preferences);
  }
  if (requirements.tripIntent) {
    requirement.tripIntent = structuredClone(requirements.tripIntent);
  }
  if (requirements.partyContext) {
    requirement.partyContext = structuredClone(requirements.partyContext);
  }
  if (requirements.constraints) {
    requirement.constraints = structuredClone(requirements.constraints);
  }
  if (requirements.profileSignals) {
    const signals = parseTravelProfileSignals(requirements.profileSignals);
    if (!signals) {
      return undefined;
    }
    requirement.profileSignals = signals;
  }
  for (const key of Object.keys(requirement)) {
    if (!REQUIREMENT_KEYS.has(key)) {
      return undefined;
    }
  }
  return requirement;
}

export class BffTripGenerationService {
  private readonly client: BffHttpClient;

  constructor(
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs = DEFAULT_TRIP_GENERATION_TIMEOUT_MS,
  ) {
    this.client = new BffHttpClient(fetchImpl, 8_000, timeoutMs);
  }

  async generate(
    requirements: CreateTripInput['requirements'],
  ): Promise<TripGenerationResult> {
    const requirement = toTripGenerationRequirement(requirements);
    if (!requirement) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const payload = await this.client.post(TRIP_GENERATE_PATH, { requirement });
    return structuredClone(parseTripGenerationPayload(payload));
  }
}
