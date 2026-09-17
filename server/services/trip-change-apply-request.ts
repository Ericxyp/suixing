import type {
  GeoPoint,
  Place,
  TransportMode,
  TransportSegment,
  Trip,
  TripDay,
  TripExperienceType,
  TripPlace,
  TripPlaceType,
  TripPreference,
  TripRoute,
  TripScheduleItem,
} from '../../src/domain/trip/types';
import {
  TRIP_CHANGE_MAX_DAYS,
  TRIP_CHANGE_MAX_QUERY_LENGTH,
} from './trip-change-intent-extractor';
import type { ReplacePlaceOperation } from './trip-change-executor';
import { isFiniteGeoPoint } from './trip-route-enricher';

export const TRIP_CHANGE_APPLY_MAX_BODY_CHARS = 80_000;
export const TRIP_CHANGE_APPLY_MAX_STOPS_PER_DAY = 8;
export const TRIP_CHANGE_APPLY_MAX_TOTAL_STOPS = 56;
export const TRIP_CHANGE_APPLY_MAX_ROUTES = 56;
export const TRIP_CHANGE_APPLY_MAX_POLYLINE_POINTS = 2_000;
export const TRIP_CHANGE_APPLY_MAX_PLACES = 56;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
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
const BODY_KEYS = new Set(['trip', 'places', 'operation']);
const TRIP_KEYS = new Set([
  'id',
  'userId',
  'title',
  'destination',
  'origin',
  'startDate',
  'endDate',
  'travelerCount',
  'totalBudget',
  'currency',
  'pace',
  'preferences',
  'status',
  'days',
  'routes',
  'createdAt',
  'updatedAt',
]);
const TRIP_REQUIRED = [
  'id',
  'userId',
  'title',
  'destination',
  'travelerCount',
  'totalBudget',
  'currency',
  'pace',
  'preferences',
  'status',
  'days',
  'routes',
  'createdAt',
  'updatedAt',
] as const;
const DAY_KEYS = new Set(['id', 'tripId', 'dayNumber', 'date', 'title', 'summary', 'places', 'scheduleItems']);
const DAY_REQUIRED = ['id', 'tripId', 'dayNumber', 'date', 'places'] as const;
const STOP_KEYS = new Set([
  'id',
  'dayId',
  'order',
  'placeId',
  'placeName',
  'type',
  'startTime',
  'endTime',
  'durationMinutes',
  'description',
  'estimatedCost',
  'transportToNext',
]);
const STOP_REQUIRED = ['id', 'dayId', 'order', 'placeId', 'placeName', 'type', 'estimatedCost'] as const;
const TRANSPORT_KEYS = new Set(['mode', 'durationMinutes', 'distanceMeters', 'description']);
const ROUTE_KEYS = new Set(['id', 'dayId', 'fromTripPlaceId', 'toTripPlaceId', 'transport', 'polyline']);
const ROUTE_REQUIRED = ['id', 'dayId', 'fromTripPlaceId', 'toTripPlaceId', 'transport'] as const;
const PLACE_KEYS = [
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
const OPERATION_KEYS = ['type', 'dayNumber', 'targetTripPlaceId', 'replacementQuery'] as const;
const FORBIDDEN_KEYS = new Set([
  'key',
  'jscode',
  'sig',
  'callback',
  'model',
  'prompt',
  'schema',
  'tools',
  'url',
  'target',
  'context',
  'stack',
  'messages',
  'poi',
  'location',
  'typecode',
  'photos',
  'tel',
]);

export interface TripChangeApplySnapshot {
  trip: Trip;
  places: Place[];
  operation: ReplacePlaceOperation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAllowed(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequired(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => key in value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(value[key]));
}

function readId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() !== value || !ID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function readNonEmpty(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (text === '' || text.length > maxLength) {
    return undefined;
  }
  return text;
}

function readTransport(value: unknown): TransportSegment | undefined {
  if (!isRecord(value) || !keysAllowed(value, TRANSPORT_KEYS) || !hasRequired(value, ['mode', 'durationMinutes', 'distanceMeters'])) {
    return undefined;
  }
  if (typeof value.mode !== 'string' || !TRANSPORT_MODES.has(value.mode as TransportMode)) {
    return undefined;
  }
  if (
    typeof value.durationMinutes !== 'number'
    || !Number.isFinite(value.durationMinutes)
    || value.durationMinutes < 0
    || typeof value.distanceMeters !== 'number'
    || !Number.isFinite(value.distanceMeters)
    || value.distanceMeters < 0
  ) {
    return undefined;
  }
  const transport: TransportSegment = {
    mode: value.mode as TransportMode,
    durationMinutes: value.durationMinutes,
    distanceMeters: value.distanceMeters,
  };
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > 200) {
      return undefined;
    }
    transport.description = value.description;
  }
  return transport;
}

function readGeo(value: unknown): GeoPoint | undefined {
  if (!isFiniteGeoPoint(value)) {
    return undefined;
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

function readTripPlace(value: unknown, dayId: string, expectedOrder: number, seenStopIds: Set<string>): TripPlace | undefined {
  if (!isRecord(value) || !keysAllowed(value, STOP_KEYS) || !hasRequired(value, STOP_REQUIRED)) {
    return undefined;
  }
  const id = readId(value.id);
  const mappedDayId = readId(value.dayId);
  const placeId = readId(value.placeId);
  const placeName = readNonEmpty(value.placeName, 80);
  if (!id || seenStopIds.has(id) || mappedDayId !== dayId || !placeId || !placeName) {
    return undefined;
  }
  if (value.order !== expectedOrder || typeof value.type !== 'string' || !PLACE_TYPES.has(value.type as TripPlaceType)) {
    return undefined;
  }
  if (typeof value.estimatedCost !== 'number' || !Number.isFinite(value.estimatedCost) || value.estimatedCost < 0) {
    return undefined;
  }
  const place: TripPlace = {
    id,
    dayId,
    order: expectedOrder,
    placeId,
    placeName,
    type: value.type as TripPlaceType,
    estimatedCost: value.estimatedCost,
  };
  if (value.startTime !== undefined) {
    if (typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
      return undefined;
    }
    place.startTime = value.startTime;
  }
  if (value.endTime !== undefined) {
    if (typeof value.endTime !== 'string' || !CLOCK_TIME.test(value.endTime)) {
      return undefined;
    }
    place.endTime = value.endTime;
  }
  if (value.durationMinutes !== undefined) {
    if (typeof value.durationMinutes !== 'number' || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1) {
      return undefined;
    }
    place.durationMinutes = value.durationMinutes;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > 200) {
      return undefined;
    }
    place.description = value.description;
  }
  if (value.transportToNext !== undefined) {
    const transport = readTransport(value.transportToNext);
    if (!transport) {
      return undefined;
    }
    place.transportToNext = transport;
  }
  seenStopIds.add(id);
  return place;
}

function readApplyScheduleItem(value: unknown, placeIds: ReadonlySet<string>): TripScheduleItem | undefined {
  if (!isRecord(value) || typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
    return undefined;
  }
  if (typeof value.durationMinutes !== 'number' || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1) {
    return undefined;
  }
  if (value.kind === 'place' || value.kind === 'meal' || value.kind === 'meal_place') {
    const tripPlaceId = readId(value.tripPlaceId);
    if (!tripPlaceId || !placeIds.has(tripPlaceId)) {
      return undefined;
    }
    if (value.kind === 'place') {
      return { kind: 'place', tripPlaceId, startTime: value.startTime, durationMinutes: value.durationMinutes };
    }
    if (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner') {
      return undefined;
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
    const id = readId(value.id);
    const areaTripPlaceId = readId(value.areaTripPlaceId);
    if (
      !id
      || !areaTripPlaceId
      || !placeIds.has(areaTripPlaceId)
      || (value.diningMode !== 'flexible' && value.diningMode !== 'self_managed')
      || (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner')
    ) {
      return undefined;
    }
    const item: TripScheduleItem = {
      kind: 'meal_slot',
      id,
      mealPeriod: value.mealPeriod,
      startTime: value.startTime,
      durationMinutes: value.durationMinutes,
      areaTripPlaceId,
      diningMode: value.diningMode,
    };
    if (value.nextTripPlaceId !== undefined) {
      const nextTripPlaceId = readId(value.nextTripPlaceId);
      if (!nextTripPlaceId || !placeIds.has(nextTripPlaceId)) {
        return undefined;
      }
      item.nextTripPlaceId = nextTripPlaceId;
    }
    return item;
  }
  if (value.kind === 'rest' || value.kind === 'hotel_return' || value.kind === 'area_walk') {
    return structuredClone(value) as TripScheduleItem;
  }
  if (value.kind !== 'experience' || typeof value.type !== 'string' || !EXPERIENCE_TYPES.has(value.type as TripExperienceType)) {
    return undefined;
  }
  const id = readId(value.id);
  if (!id || typeof value.title !== 'string' || typeof value.description !== 'string') {
    return undefined;
  }
  return {
    kind: 'experience',
    id,
    startTime: value.startTime,
    durationMinutes: value.durationMinutes,
    type: value.type as TripExperienceType,
    title: value.title,
    description: value.description,
  };
}

function readDay(
  value: unknown,
  tripId: string,
  expectedDayNumber: number,
  seenDayIds: Set<string>,
  seenStopIds: Set<string>,
): TripDay | undefined {
  if (!isRecord(value) || !keysAllowed(value, DAY_KEYS) || !hasRequired(value, DAY_REQUIRED)) {
    return undefined;
  }
  const id = readId(value.id);
  if (!id || seenDayIds.has(id) || readId(value.tripId) !== tripId || value.dayNumber !== expectedDayNumber) {
    return undefined;
  }
  if (typeof value.date !== 'string' || (value.date !== '' && !CALENDAR_DATE.test(value.date))) {
    return undefined;
  }
  if (!Array.isArray(value.places) || value.places.length < 1 || value.places.length > TRIP_CHANGE_APPLY_MAX_STOPS_PER_DAY) {
    return undefined;
  }
  const places: TripPlace[] = [];
  for (const [index, placeValue] of value.places.entries()) {
    const place = readTripPlace(placeValue, id, index + 1, seenStopIds);
    if (!place) {
      return undefined;
    }
    places.push(place);
  }
  const day: TripDay = {
    id,
    tripId,
    dayNumber: expectedDayNumber,
    date: value.date,
    places,
  };
  if (value.title !== undefined) {
    const title = readNonEmpty(value.title, 80);
    if (!title) {
      return undefined;
    }
    day.title = title;
  }
  if (value.summary !== undefined) {
    const summary = readNonEmpty(value.summary, 200);
    if (!summary) {
      return undefined;
    }
    day.summary = summary;
  }
  seenDayIds.add(id);
  if (value.scheduleItems !== undefined) {
    if (!Array.isArray(value.scheduleItems) || value.scheduleItems.length > MAX_DAY_SCHEDULE_ITEMS) {
      return undefined;
    }
    const placeIds = new Set(places.map((place) => place.id));
    const scheduleItems: TripScheduleItem[] = [];
    for (const item of value.scheduleItems) {
      const parsed = readApplyScheduleItem(item, placeIds);
      if (!parsed) {
        return undefined;
      }
      scheduleItems.push(parsed);
    }
    day.scheduleItems = scheduleItems;
  }
  return day;
}

function readRoute(
  value: unknown,
  days: TripDay[],
  seenRouteIds: Set<string>,
): TripRoute | undefined {
  if (!isRecord(value) || !keysAllowed(value, ROUTE_KEYS) || !hasRequired(value, ROUTE_REQUIRED)) {
    return undefined;
  }
  const id = readId(value.id);
  const dayId = readId(value.dayId);
  const fromTripPlaceId = readId(value.fromTripPlaceId);
  const toTripPlaceId = readId(value.toTripPlaceId);
  if (!id || !dayId || !fromTripPlaceId || !toTripPlaceId || fromTripPlaceId === toTripPlaceId || seenRouteIds.has(id)) {
    return undefined;
  }
  const day = days.find((item) => item.id === dayId);
  if (!day) {
    return undefined;
  }
  const fromOnDay = day.places.some((place) => place.id === fromTripPlaceId);
  const toOnDay = day.places.some((place) => place.id === toTripPlaceId);
  if (!fromOnDay || !toOnDay) {
    return undefined;
  }
  const transport = readTransport(value.transport);
  if (!transport) {
    return undefined;
  }
  const route: TripRoute = {
    id,
    dayId,
    fromTripPlaceId,
    toTripPlaceId,
    transport,
  };
  if (value.polyline !== undefined) {
    if (!Array.isArray(value.polyline) || value.polyline.length < 2 || value.polyline.length > TRIP_CHANGE_APPLY_MAX_POLYLINE_POINTS) {
      return undefined;
    }
    const polyline: GeoPoint[] = [];
    for (const point of value.polyline) {
      const geo = readGeo(point);
      if (!geo || (isRecord(point) && !keysAllowed(point, new Set(['latitude', 'longitude'])))) {
        return undefined;
      }
      polyline.push(geo);
    }
    route.polyline = polyline;
  }
  seenRouteIds.add(id);
  return route;
}

function readPreferences(value: unknown): TripPreference | undefined {
  if (!isRecord(value) || !keysAllowed(value, PREFERENCE_KEYS) || !Array.isArray(value.interests)) {
    return undefined;
  }
  if (!value.interests.every((item) => typeof item === 'string' && item.length <= 40)) {
    return undefined;
  }
  const preferences: TripPreference = {
    interests: value.interests.filter((item): item is string => typeof item === 'string'),
  };
  for (const key of ['accommodation', 'mustVisit', 'avoid'] as const) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string' && item.length <= 40)) {
        return undefined;
      }
      preferences[key] = value[key] as string[];
    }
  }
  return preferences;
}

function readPlace(value: unknown, seenPlaceIds: Set<string>): Place | undefined {
  if (!isRecord(value) || Object.keys(value).length !== PLACE_KEYS.length) {
    return undefined;
  }
  for (const key of PLACE_KEYS) {
    if (!(key in value)) {
      return undefined;
    }
  }
  const id = readId(value.id);
  if (!id || seenPlaceIds.has(id)) {
    return undefined;
  }
  if (value.provider !== 'amap' && value.provider !== 'mock') {
    return undefined;
  }
  if (typeof value.category !== 'string' || !PLACE_TYPES.has(value.category as TripPlaceType)) {
    return undefined;
  }
  const geo = readGeo({ latitude: value.latitude, longitude: value.longitude });
  const name = readNonEmpty(value.name, 80);
  const providerPlaceId = readNonEmpty(value.providerPlaceId, 64);
  if (!geo || !name || !providerPlaceId || typeof value.address !== 'string' || value.address.length > 200) {
    return undefined;
  }
  seenPlaceIds.add(id);
  return {
    id,
    provider: value.provider,
    providerPlaceId,
    name,
    address: value.address,
    latitude: geo.latitude,
    longitude: geo.longitude,
    category: value.category as TripPlaceType,
  };
}

function readTrip(value: unknown): Trip | undefined {
  if (!isRecord(value) || !keysAllowed(value, TRIP_KEYS) || !hasRequired(value, TRIP_REQUIRED)) {
    return undefined;
  }
  const id = readId(value.id);
  const userId = readId(value.userId);
  const title = readNonEmpty(value.title, 80);
  const destination = readNonEmpty(value.destination, 80);
  if (!id || !userId || !title || !destination) {
    return undefined;
  }
  if (value.currency !== 'CNY' || typeof value.pace !== 'string' || !PACES.has(value.pace)) {
    return undefined;
  }
  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) {
    return undefined;
  }
  if (
    typeof value.travelerCount !== 'number'
    || !Number.isInteger(value.travelerCount)
    || value.travelerCount < 1
    || value.travelerCount > 20
    || typeof value.totalBudget !== 'number'
    || !Number.isFinite(value.totalBudget)
    || value.totalBudget < 0
  ) {
    return undefined;
  }
  if (typeof value.createdAt !== 'string' || !ISO_TIMESTAMP.test(value.createdAt)) {
    return undefined;
  }
  if (typeof value.updatedAt !== 'string' || !ISO_TIMESTAMP.test(value.updatedAt)) {
    return undefined;
  }
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > TRIP_CHANGE_MAX_DAYS) {
    return undefined;
  }
  if (!Array.isArray(value.routes) || value.routes.length > TRIP_CHANGE_APPLY_MAX_ROUTES) {
    return undefined;
  }
  const preferences = readPreferences(value.preferences);
  if (!preferences) {
    return undefined;
  }
  const seenDayIds = new Set<string>();
  const seenStopIds = new Set<string>();
  const days: TripDay[] = [];
  for (const [index, dayValue] of value.days.entries()) {
    const day = readDay(dayValue, id, index + 1, seenDayIds, seenStopIds);
    if (!day) {
      return undefined;
    }
    days.push(day);
  }
  if (seenStopIds.size > TRIP_CHANGE_APPLY_MAX_TOTAL_STOPS) {
    return undefined;
  }
  const seenRouteIds = new Set<string>();
  const routes: TripRoute[] = [];
  for (const routeValue of value.routes) {
    const route = readRoute(routeValue, days, seenRouteIds);
    if (!route) {
      return undefined;
    }
    routes.push(route);
  }
  const trip: Trip = {
    id,
    userId,
    title,
    destination,
    travelerCount: value.travelerCount,
    totalBudget: value.totalBudget,
    currency: 'CNY',
    pace: value.pace as Trip['pace'],
    preferences,
    status: value.status as Trip['status'],
    days,
    routes,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.origin !== undefined) {
    const origin = readNonEmpty(value.origin, 80);
    if (!origin) {
      return undefined;
    }
    trip.origin = origin;
  }
  if (value.startDate !== undefined) {
    if (typeof value.startDate !== 'string' || !CALENDAR_DATE.test(value.startDate)) {
      return undefined;
    }
    trip.startDate = value.startDate;
  }
  if (value.endDate !== undefined) {
    if (typeof value.endDate !== 'string' || !CALENDAR_DATE.test(value.endDate)) {
      return undefined;
    }
    trip.endDate = value.endDate;
  }
  return trip;
}

function readOperation(value: unknown, trip: Trip): ReplacePlaceOperation | undefined {
  if (!isRecord(value) || Object.keys(value).length !== OPERATION_KEYS.length) {
    return undefined;
  }
  for (const key of OPERATION_KEYS) {
    if (!(key in value)) {
      return undefined;
    }
  }
  if (value.type !== 'REPLACE_PLACE' || typeof value.dayNumber !== 'number' || !Number.isInteger(value.dayNumber)) {
    return undefined;
  }
  const day = trip.days.find((item) => item.dayNumber === value.dayNumber);
  const targetTripPlaceId = readId(value.targetTripPlaceId);
  if (!day || !targetTripPlaceId) {
    return undefined;
  }
  if (!day.places.some((place) => place.id === targetTripPlaceId)) {
    return undefined;
  }
  if (trip.days.some((item) => item.dayNumber !== value.dayNumber && item.places.some((place) => place.id === targetTripPlaceId))) {
    return undefined;
  }
  if (typeof value.replacementQuery !== 'string') {
    return undefined;
  }
  const replacementQuery = value.replacementQuery.trim();
  if (
    replacementQuery === ''
    || replacementQuery.length > TRIP_CHANGE_MAX_QUERY_LENGTH
    || /https?:\/\//i.test(replacementQuery)
  ) {
    return undefined;
  }
  return {
    type: 'REPLACE_PLACE',
    dayNumber: value.dayNumber,
    targetTripPlaceId,
    replacementQuery,
  };
}

function referencedPlaceIds(trip: Trip): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const day of trip.days) {
    for (const stop of day.places) {
      if (seen.has(stop.placeId)) {
        continue;
      }
      seen.add(stop.placeId);
      ids.push(stop.placeId);
    }
  }
  return ids;
}

function parseApplyTripPlaces(body: Record<string, unknown>): { trip: Trip; places: Place[] } | undefined {
  const trip = readTrip(body.trip);
  if (!trip) {
    return undefined;
  }
  if (!Array.isArray(body.places) || body.places.length < 1 || body.places.length > TRIP_CHANGE_APPLY_MAX_PLACES) {
    return undefined;
  }
  const seenPlaceIds = new Set<string>();
  const places: Place[] = [];
  for (const placeValue of body.places) {
    const place = readPlace(placeValue, seenPlaceIds);
    if (!place) {
      return undefined;
    }
    places.push(place);
  }
  const referenced = referencedPlaceIds(trip);
  if (places.length !== referenced.length) {
    return undefined;
  }
  const byId = new Map(places.map((place) => [place.id, place]));
  for (const placeId of referenced) {
    if (!byId.has(placeId)) {
      return undefined;
    }
  }
  return { trip, places };
}

export function parseTripChangeApplyBody(body: unknown): TripChangeApplySnapshot | undefined {
  try {
    if (JSON.stringify(body).length > TRIP_CHANGE_APPLY_MAX_BODY_CHARS) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (!isRecord(body) || containsForbiddenKey(body) || !keysAllowed(body, BODY_KEYS)) {
    return undefined;
  }
  if (!('trip' in body) || !('places' in body) || !('operation' in body) || Object.keys(body).length !== 3) {
    return undefined;
  }
  const snapshot = parseApplyTripPlaces(body);
  if (!snapshot) {
    return undefined;
  }
  const operation = readOperation(body.operation, snapshot.trip);
  if (!operation) {
    return undefined;
  }
  return { trip: snapshot.trip, places: snapshot.places, operation };
}

export { parseApplyTripPlaces };
