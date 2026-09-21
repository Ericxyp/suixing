import type { Place, Trip, TripExperienceType, TripScheduleItem } from '../domain/trip/types';
import { parseTripPlanningContextV1 } from '../domain/trip/profile';
import { referencedPlaceIdsInTripOrder } from './trip-repository';

export const TRIP_REPOSITORY_STORAGE_KEY = 'suixing.trip-repository.v1';
export const TRIP_REPOSITORY_STORAGE_VERSION = 1;
export const TRIP_SESSION_ONLY_NOTICE = '行程仅保存在当前会话中。';
export const MAX_STORED_TRIPS = 50;
export const MAX_STORED_DAYS = 14;
export const MAX_STORED_STOPS_PER_DAY = 8;
export const MAX_STORED_SCHEDULE_ITEMS_PER_DAY = 12;
export const MAX_STORED_POLYLINE_POINTS = 2_000;
export const RECENT_TRIP_LIMIT = 6;

export interface TripStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StoredTripRecord {
  trip: Trip;
  places: Place[];
}

export interface TripRepositoryStore {
  version: typeof TRIP_REPOSITORY_STORAGE_VERSION;
  records: StoredTripRecord[];
  removedSeedIds: string[];
}

const STORE_KEYS = ['version', 'records', 'removedSeedIds'] as const;
const RECORD_KEYS = ['trip', 'places'] as const;
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
const PROTECTED_KEYS = new Set([
  'key',
  'jscode',
  'sig',
  'model',
  'prompt',
  'schema',
  'tools',
  'url',
  'target',
  'callback',
  'innerHTML',
  'html',
]);
const PLACE_TYPES = new Set([
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
]);
const PLACE_PROVIDERS = new Set(['amap', 'mock']);
const PACES = new Set(['relaxed', 'balanced', 'packed']);
const STATUSES = new Set(['PLANNING', 'READY', 'TRAVELLING', 'COMPLETED']);
const TRANSPORT_MODES = new Set(['walk', 'metro', 'taxi', 'bus', 'drive']);
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const EXPERIENCE_TYPES = new Set(['meal', 'walk', 'free_time', 'night', 'rest']);
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function containsProtectedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsProtectedKey(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => (
    PROTECTED_KEYS.has(key) || containsProtectedKey(value[key])
  ));
}

function readId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

function readText(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined;
}

function readOptionalText(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 20) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    const text = readText(item, 40);
    if (text === undefined) {
      return undefined;
    }
    items.push(text);
  }
  return items;
}

function readTransport(value: unknown): Trip['routes'][number]['transport'] | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    typeof value.mode !== 'string'
    || !TRANSPORT_MODES.has(value.mode)
    || typeof value.durationMinutes !== 'number'
    || !Number.isInteger(value.durationMinutes)
    || value.durationMinutes < 0
    || typeof value.distanceMeters !== 'number'
    || !Number.isInteger(value.distanceMeters)
    || value.distanceMeters < 0
  ) {
    return undefined;
  }
  const description = readOptionalText(value.description);
  if ('description' in value && description === undefined) {
    return undefined;
  }
  if (keys.some((key) => key !== 'mode' && key !== 'durationMinutes' && key !== 'distanceMeters' && key !== 'description')) {
    return undefined;
  }
  return description !== undefined
    ? {
      mode: value.mode as Trip['routes'][number]['transport']['mode'],
      durationMinutes: value.durationMinutes,
      distanceMeters: value.distanceMeters,
      description,
    }
    : {
      mode: value.mode as Trip['routes'][number]['transport']['mode'],
      durationMinutes: value.durationMinutes,
      distanceMeters: value.distanceMeters,
    };
}

function readGeoPoint(value: unknown): { latitude: number; longitude: number } | undefined {
  if (!isRecord(value) || containsProtectedKey(value) || !hasExactKeys(value, ['latitude', 'longitude'])) {
    return undefined;
  }
  const latitude = readFinite(value.latitude);
  const longitude = readFinite(value.longitude);
  if (
    latitude === undefined
    || longitude === undefined
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    return undefined;
  }
  return { latitude, longitude };
}

function readPlace(value: unknown): Place | undefined {
  if (!isRecord(value) || containsProtectedKey(value) || !hasExactKeys(value, PLACE_KEYS)) {
    return undefined;
  }
  if (typeof value.provider !== 'string' || !PLACE_PROVIDERS.has(value.provider)) {
    return undefined;
  }
  if (typeof value.category !== 'string' || !PLACE_TYPES.has(value.category)) {
    return undefined;
  }
  const id = readId(value.id);
  const providerPlaceId = readText(value.providerPlaceId, 80);
  const name = readText(value.name, 80);
  const address = readOptionalText(value.address, MAX_TEXT);
  const latitude = readFinite(value.latitude);
  const longitude = readFinite(value.longitude);
  if (
    id === undefined
    || providerPlaceId === undefined
    || name === undefined
    || address === undefined
    || latitude === undefined
    || longitude === undefined
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    return undefined;
  }
  return {
    id,
    provider: value.provider as Place['provider'],
    providerPlaceId,
    name,
    address,
    latitude,
    longitude,
    category: value.category as Place['category'],
  };
}

function readTripPlace(value: unknown): Trip['days'][number]['places'][number] | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  const allowed = new Set([
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
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const id = readId(value.id);
  const dayId = readId(value.dayId);
  const order = readInteger(value.order);
  const placeId = readId(value.placeId);
  const placeName = readText(value.placeName, 80);
  if (
    id === undefined
    || dayId === undefined
    || order === undefined
    || order < 1
    || placeId === undefined
    || placeName === undefined
    || typeof value.type !== 'string'
    || !PLACE_TYPES.has(value.type)
    || typeof value.estimatedCost !== 'number'
    || !Number.isFinite(value.estimatedCost)
  ) {
    return undefined;
  }
  const place: Trip['days'][number]['places'][number] = {
    id,
    dayId,
    order,
    placeId,
    placeName,
    type: value.type as Trip['days'][number]['places'][number]['type'],
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
    const durationMinutes = readInteger(value.durationMinutes);
    if (durationMinutes === undefined || durationMinutes < 0) {
      return undefined;
    }
    place.durationMinutes = durationMinutes;
  }
  if (value.description !== undefined) {
    const description = readOptionalText(value.description, MAX_DESCRIPTION);
    if (description === undefined) {
      return undefined;
    }
    if (description !== '') {
      place.description = description;
    }
  }
  if (value.transportToNext !== undefined) {
    const transport = readTransport(value.transportToNext);
    if (!transport) {
      return undefined;
    }
    place.transportToNext = transport;
  }
  return place;
}

function readScheduleItem(value: unknown, placeIds: ReadonlySet<string>): TripScheduleItem | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  if (typeof value.startTime !== 'string' || !CLOCK_TIME.test(value.startTime)) {
    return undefined;
  }
  const durationMinutes = readInteger(value.durationMinutes);
  if (durationMinutes === undefined || durationMinutes < 1 || durationMinutes > 24 * 60) {
    return undefined;
  }
  if (value.kind === 'place' || value.kind === 'meal' || value.kind === 'meal_place') {
    const tripPlaceId = readId(value.tripPlaceId);
    if (!tripPlaceId || !placeIds.has(tripPlaceId)) {
      return undefined;
    }
    if (value.kind === 'place') {
      return { kind: 'place', tripPlaceId, startTime: value.startTime, durationMinutes };
    }
    if (value.mealPeriod !== 'lunch' && value.mealPeriod !== 'dinner') {
      return undefined;
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
      durationMinutes,
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
  if (value.kind === 'rest') {
    if (value.title !== '午间休息' && value.title !== '参观后休息') {
      return undefined;
    }
    const id = readId(value.id);
    const description = readText(value.description, MAX_DESCRIPTION);
    if (!id || !description || durationMinutes > 45) {
      return undefined;
    }
    return {
      kind: 'rest',
      id,
      startTime: value.startTime,
      durationMinutes,
      title: value.title,
      description,
    };
  }
  if (value.kind === 'hotel_return') {
    const id = readId(value.id);
    const description = readText(value.description, MAX_DESCRIPTION);
    if (!id || value.title !== '返程准备' || !description) {
      return undefined;
    }
    return {
      kind: 'hotel_return',
      id,
      startTime: value.startTime,
      durationMinutes,
      title: '返程准备',
      description,
    };
  }
  if (value.kind === 'area_walk') {
    const id = readId(value.id);
    const areaTripPlaceId = readId(value.areaTripPlaceId);
    const title = readText(value.title, 40);
    const description = readText(value.description, MAX_DESCRIPTION);
    if (
      !id
      || !areaTripPlaceId
      || !placeIds.has(areaTripPlaceId)
      || !title
      || !description
      || !Array.isArray(value.optionTripPlaceIds)
    ) {
      return undefined;
    }
    const optionTripPlaceIds: string[] = [];
    for (const option of value.optionTripPlaceIds) {
      const optionId = readId(option);
      if (!optionId || !placeIds.has(optionId)) {
        return undefined;
      }
      optionTripPlaceIds.push(optionId);
    }
    return {
      kind: 'area_walk',
      id,
      startTime: value.startTime,
      durationMinutes,
      areaTripPlaceId,
      optionTripPlaceIds,
      title,
      description,
    };
  }
  if (value.kind !== 'experience') {
    return undefined;
  }
  if (typeof value.type !== 'string' || !EXPERIENCE_TYPES.has(value.type)) {
    return undefined;
  }
  const id = readId(value.id);
  const title = readText(value.title, 40);
  const description = readText(value.description, MAX_DESCRIPTION);
  if (!id || !title || !description) {
    return undefined;
  }
  return {
    kind: 'experience',
    id,
    startTime: value.startTime,
    durationMinutes,
    type: value.type as TripExperienceType,
    title,
    description,
  };
}

function readDay(value: unknown, tripId: string, expectedDayNumber: number): Trip['days'][number] | undefined {
  if (!isRecord(value) || containsProtectedKey(value) || !Array.isArray(value.places)) {
    return undefined;
  }
  const allowed = new Set(['id', 'tripId', 'dayNumber', 'date', 'title', 'summary', 'places', 'scheduleItems']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const id = readId(value.id);
  const storedTripId = readId(value.tripId);
  if (
    id === undefined
    || storedTripId !== tripId
    || value.dayNumber !== expectedDayNumber
    || typeof value.date !== 'string'
    || (value.date !== '' && !DAY_DATE.test(value.date))
    || value.places.length > MAX_STORED_STOPS_PER_DAY
  ) {
    return undefined;
  }
  const places: Trip['days'][number]['places'] = [];
  for (const item of value.places) {
    const place = readTripPlace(item);
    if (!place || place.dayId !== id) {
      return undefined;
    }
    places.push(place);
  }
  const day: Trip['days'][number] = {
    id,
    tripId,
    dayNumber: expectedDayNumber,
    date: value.date,
    places,
  };
  if (value.title !== undefined) {
    const title = readOptionalText(value.title, 80);
    if (title === undefined) {
      return undefined;
    }
    if (title !== '') {
      day.title = title;
    }
  }
  if (value.summary !== undefined) {
    const summary = readOptionalText(value.summary, MAX_DESCRIPTION);
    if (summary === undefined) {
      return undefined;
    }
    if (summary !== '') {
      day.summary = summary;
    }
  }
  if (value.scheduleItems !== undefined) {
    if (!Array.isArray(value.scheduleItems) || value.scheduleItems.length > MAX_STORED_SCHEDULE_ITEMS_PER_DAY) {
      return undefined;
    }
    const placeIds = new Set(places.map((place) => place.id));
    const scheduleItems: TripScheduleItem[] = [];
    for (const item of value.scheduleItems) {
      const parsed = readScheduleItem(item, placeIds);
      if (!parsed) {
        continue;
      }
      scheduleItems.push(parsed);
    }
    day.scheduleItems = scheduleItems;
  }
  return day;
}

function readRoute(value: unknown): Trip['routes'][number] | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  const allowed = new Set(['id', 'dayId', 'fromTripPlaceId', 'toTripPlaceId', 'transport', 'polyline']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const id = readId(value.id);
  const dayId = readId(value.dayId);
  const fromTripPlaceId = readId(value.fromTripPlaceId);
  const toTripPlaceId = readId(value.toTripPlaceId);
  const transport = readTransport(value.transport);
  if (
    id === undefined
    || dayId === undefined
    || fromTripPlaceId === undefined
    || toTripPlaceId === undefined
    || !transport
  ) {
    return undefined;
  }
  const route: Trip['routes'][number] = {
    id,
    dayId,
    fromTripPlaceId,
    toTripPlaceId,
    transport,
  };
  if (value.polyline !== undefined) {
    if (!Array.isArray(value.polyline) || value.polyline.length > MAX_STORED_POLYLINE_POINTS) {
      return undefined;
    }
    const polyline: NonNullable<Trip['routes'][number]['polyline']> = [];
    for (const point of value.polyline) {
      const parsed = readGeoPoint(point);
      if (!parsed) {
        return undefined;
      }
      polyline.push(parsed);
    }
    route.polyline = polyline;
  }
  return route;
}

function readPreferences(value: unknown): Trip['preferences'] | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  const allowed = new Set(['interests', 'accommodation', 'mustVisit', 'avoid']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const interests = readStringList(value.interests);
  if (!interests) {
    return undefined;
  }
  const preferences: Trip['preferences'] = { interests };
  for (const key of ['accommodation', 'mustVisit', 'avoid'] as const) {
    if (value[key] === undefined) {
      continue;
    }
    const list = readStringList(value[key]);
    if (!list) {
      return undefined;
    }
    preferences[key] = list;
  }
  return preferences;
}

function readTrip(value: unknown): Trip | undefined {
  if (!isRecord(value) || containsProtectedKey(value) || !Array.isArray(value.days) || !Array.isArray(value.routes)) {
    return undefined;
  }
  const allowed = new Set([
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
    'planningContext',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const id = readId(value.id);
  const userId = readId(value.userId);
  const title = readText(value.title, 80);
  const destination = readText(value.destination, 40);
  const travelerCount = readInteger(value.travelerCount);
  const totalBudget = readFinite(value.totalBudget);
  const createdAt = readText(value.createdAt, 40);
  const updatedAt = readText(value.updatedAt, 40);
  const preferences = readPreferences(value.preferences);
  if (
    id === undefined
    || userId === undefined
    || title === undefined
    || destination === undefined
    || travelerCount === undefined
    || travelerCount < 1
    || totalBudget === undefined
    || createdAt === undefined
    || updatedAt === undefined
    || !preferences
    || value.currency !== 'CNY'
    || typeof value.pace !== 'string'
    || !PACES.has(value.pace)
    || typeof value.status !== 'string'
    || !STATUSES.has(value.status)
    || value.days.length > MAX_STORED_DAYS
  ) {
    return undefined;
  }
  const days: Trip['days'] = [];
  for (const [index, item] of value.days.entries()) {
    const day = readDay(item, id, index + 1);
    if (!day) {
      return undefined;
    }
    days.push(day);
  }
  const routes: Trip['routes'] = [];
  for (const item of value.routes) {
    const route = readRoute(item);
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
    travelerCount,
    totalBudget,
    currency: 'CNY',
    pace: value.pace as Trip['pace'],
    preferences,
    status: value.status as Trip['status'],
    days,
    routes,
    createdAt,
    updatedAt,
  };
  if (value.origin !== undefined) {
    const origin = readOptionalText(value.origin, 40);
    if (origin === undefined) {
      return undefined;
    }
    if (origin !== '') {
      trip.origin = origin;
    }
  }
  if (value.startDate !== undefined) {
    if (typeof value.startDate !== 'string' || (value.startDate !== '' && !DAY_DATE.test(value.startDate))) {
      return undefined;
    }
    if (value.startDate !== '') {
      trip.startDate = value.startDate;
    }
  }
  if (value.endDate !== undefined) {
    if (typeof value.endDate !== 'string' || (value.endDate !== '' && !DAY_DATE.test(value.endDate))) {
      return undefined;
    }
    if (value.endDate !== '') {
      trip.endDate = value.endDate;
    }
  }
  if (value.planningContext !== undefined) {
    const planningContext = parseTripPlanningContextV1(value.planningContext);
    if (!planningContext) {
      return undefined;
    }
    trip.planningContext = planningContext;
  }
  return trip;
}

function readRecord(value: unknown): StoredTripRecord | undefined {
  if (!isRecord(value) || containsProtectedKey(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return undefined;
  }
  const trip = readTrip(value.trip);
  if (!trip || !Array.isArray(value.places)) {
    return undefined;
  }
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const item of value.places) {
    const place = readPlace(item);
    if (!place || seen.has(place.id)) {
      return undefined;
    }
    seen.add(place.id);
    places.push(place);
  }
  const referenced = referencedPlaceIdsInTripOrder(trip);
  if (referenced.some((placeId) => !seen.has(placeId))) {
    return undefined;
  }
  return {
    trip,
    places: referenced.map((placeId) => structuredClone(places.find((item) => item.id === placeId)!)),
  };
}

export function parseTripRepositoryStore(value: unknown): TripRepositoryStore | undefined {
  if (!isRecord(value) || containsProtectedKey(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (value.version !== TRIP_REPOSITORY_STORAGE_VERSION) {
    return undefined;
  }
  if (keys.some((key) => !STORE_KEYS.includes(key as typeof STORE_KEYS[number]))) {
    return undefined;
  }
  if (!Array.isArray(value.records)) {
    return undefined;
  }
  const records: StoredTripRecord[] = [];
  const seenTripIds = new Set<string>();
  for (const item of value.records) {
    if (records.length >= MAX_STORED_TRIPS) {
      break;
    }
    const record = readRecord(item);
    if (!record || seenTripIds.has(record.trip.id)) {
      continue;
    }
    seenTripIds.add(record.trip.id);
    records.push(record);
  }
  const removedSeedIds: string[] = [];
  if (value.removedSeedIds !== undefined) {
    if (!Array.isArray(value.removedSeedIds)) {
      return undefined;
    }
    for (const item of value.removedSeedIds) {
      const id = readId(item);
      if (id && !removedSeedIds.includes(id)) {
        removedSeedIds.push(id);
      }
    }
  }
  return {
    version: TRIP_REPOSITORY_STORAGE_VERSION,
    records,
    removedSeedIds,
  };
}

function serializeTransport(value: Trip['routes'][number]['transport']) {
  return value.description
    ? {
      mode: value.mode,
      durationMinutes: value.durationMinutes,
      distanceMeters: value.distanceMeters,
      description: value.description,
    }
    : {
      mode: value.mode,
      durationMinutes: value.durationMinutes,
      distanceMeters: value.distanceMeters,
    };
}

function serializeTrip(trip: Trip): Record<string, unknown> {
  return {
    id: trip.id,
    userId: trip.userId,
    title: trip.title,
    destination: trip.destination,
    ...(trip.origin ? { origin: trip.origin } : {}),
    ...(trip.startDate ? { startDate: trip.startDate } : {}),
    ...(trip.endDate ? { endDate: trip.endDate } : {}),
    travelerCount: trip.travelerCount,
    totalBudget: trip.totalBudget,
    currency: trip.currency,
    pace: trip.pace,
    preferences: {
      interests: [...trip.preferences.interests],
      ...(trip.preferences.accommodation ? { accommodation: [...trip.preferences.accommodation] } : {}),
      ...(trip.preferences.mustVisit ? { mustVisit: [...trip.preferences.mustVisit] } : {}),
      ...(trip.preferences.avoid ? { avoid: [...trip.preferences.avoid] } : {}),
    },
    status: trip.status,
    days: trip.days.map((day) => ({
      id: day.id,
      tripId: day.tripId,
      dayNumber: day.dayNumber,
      date: day.date,
      ...(day.title ? { title: day.title } : {}),
      ...(day.summary ? { summary: day.summary } : {}),
      places: day.places.map((place) => ({
        id: place.id,
        dayId: place.dayId,
        order: place.order,
        placeId: place.placeId,
        placeName: place.placeName,
        type: place.type,
        ...(place.startTime ? { startTime: place.startTime } : {}),
        ...(place.endTime ? { endTime: place.endTime } : {}),
        ...(place.durationMinutes !== undefined ? { durationMinutes: place.durationMinutes } : {}),
        ...(place.description ? { description: place.description } : {}),
        estimatedCost: place.estimatedCost,
        ...(place.transportToNext ? { transportToNext: serializeTransport(place.transportToNext) } : {}),
      })),
      ...(day.scheduleItems
        ? {
          scheduleItems: day.scheduleItems.slice(0, MAX_STORED_SCHEDULE_ITEMS_PER_DAY).map((item) => structuredClone(item)),
        }
        : {}),
    })),
    routes: trip.routes.map((route) => ({
      id: route.id,
      dayId: route.dayId,
      fromTripPlaceId: route.fromTripPlaceId,
      toTripPlaceId: route.toTripPlaceId,
      transport: serializeTransport(route.transport),
      ...(route.polyline
        ? {
          polyline: route.polyline.slice(0, MAX_STORED_POLYLINE_POINTS).map((point) => ({
            latitude: point.latitude,
            longitude: point.longitude,
          })),
        }
        : {}),
    })),
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
    ...(trip.planningContext ? { planningContext: structuredClone(trip.planningContext) } : {}),
  };
}

function serializePlace(place: Place): Record<string, unknown> {
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

export function serializeTripRepositoryStore(store: TripRepositoryStore): string {
  return JSON.stringify({
    version: TRIP_REPOSITORY_STORAGE_VERSION,
    records: store.records.slice(0, MAX_STORED_TRIPS).map((record) => ({
      trip: serializeTrip(record.trip),
      places: referencedPlaceIdsInTripOrder(record.trip).map((placeId) => {
        const place = record.places.find((item) => item.id === placeId);
        return place ? serializePlace(place) : undefined;
      }).filter((item): item is Record<string, unknown> => item !== undefined),
    })),
    removedSeedIds: [...store.removedSeedIds],
  });
}

export function readTripRepositoryStore(storage: TripStorage | null): TripRepositoryStore {
  const empty: TripRepositoryStore = {
    version: TRIP_REPOSITORY_STORAGE_VERSION,
    records: [],
    removedSeedIds: [],
  };
  if (!storage) {
    return empty;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(TRIP_REPOSITORY_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return empty;
  }
  try {
    return parseTripRepositoryStore(JSON.parse(raw)) ?? empty;
  } catch {
    return empty;
  }
}

export function writeTripRepositoryStore(
  storage: TripStorage | null,
  store: TripRepositoryStore,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(TRIP_REPOSITORY_STORAGE_KEY, serializeTripRepositoryStore(store));
    return true;
  } catch {
    return false;
  }
}

let persistenceNotice: string | null = null;

export function consumeTripPersistenceNotice(): string | null {
  const notice = persistenceNotice;
  persistenceNotice = null;
  return notice;
}

export function noteTripPersistenceFailure(): void {
  persistenceNotice = TRIP_SESSION_ONLY_NOTICE;
}

export function browserTripStorage(): TripStorage | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return null;
    }
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function selectRecentTrips(trips: readonly Trip[], limit = RECENT_TRIP_LIMIT): Trip[] {
  return [...trips]
    .sort((left, right) => {
      const time = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return Number.isFinite(time) && time !== 0 ? time : right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}

export function tripListedDayCount(trip: Trip): number | undefined {
  if (trip.days.length > 0) {
    return trip.days.length;
  }
  if (!trip.startDate || !trip.endDate) {
    return undefined;
  }
  const start = Date.parse(`${trip.startDate}T00:00:00Z`);
  const end = Date.parse(`${trip.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return Math.round((end - start) / 86_400_000) + 1;
}
