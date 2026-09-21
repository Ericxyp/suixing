import type {
  GeoPoint,
  Place,
  TransportSegment,
  Trip,
  TripDay,
  TripPace,
  TripPlace,
  TripPlaceType,
  TripPreference,
  TripRoute,
} from '../../src/domain/trip/types';
import type { TripPlanningContextV1 } from '../../src/domain/trip/profile';
import {
  parseConfirmedTripRequirement,
  type ConfirmedTripRequirement,
} from './trip-plan-generator';
import type {
  EnrichedTripRoute,
  RouteEnrichedTripPlanDay,
  RouteEnrichedTripPlanSuggestion,
  UnresolvedTripRoute,
} from './trip-route-enricher';
import { planDaySchedule, type TripSchedulePolicy } from './trip-day-density-planner';
import type { ResolvedTripPlaceStop } from './trip-place-resolver';

export class TripBuilderError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST',
    message: string,
  ) {
    super(message);
  }
}

export interface BuildTripInput {
  requirement: ConfirmedTripRequirement;
  plan: RouteEnrichedTripPlanSuggestion;
  tripId: string;
  userId: string;
  createdAt: string;
  planningPolicy?: TripSchedulePolicy;
}

export interface TripBuildDiagnostics {
  unresolvedPlacesCount: number;
  unresolvedRoutesCount: number;
}

export interface TripBuildResult {
  trip: Trip;
  places: Place[];
  diagnostics: TripBuildDiagnostics;
}

export interface TripBuilder {
  build(input: BuildTripInput): TripBuildResult;
}

export const TRIP_BUILDER_INVALID_REQUEST_MESSAGE = '行程构建请求无效，请调整后重试。';
export const FALLBACK_DAY_SUMMARY = '当天行程待补充。';

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_TITLE_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 200;
const PLACE_TYPES = new Set<TripPlaceType>([
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
]);
const TRANSPORT_MODES = new Set(['walk', 'taxi', 'metro', 'bus', 'drive']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new TripBuilderError('INVALID_REQUEST', TRIP_BUILDER_INVALID_REQUEST_MESSAGE);
}

function readNonEmptyString(value: unknown, maxLength = MAX_TITLE_LENGTH): string {
  if (typeof value !== 'string') {
    invalidRequest();
  }
  const text = value.trim();
  if (text === '' || text.length > maxLength) {
    invalidRequest();
  }
  return text;
}

function readOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    invalidRequest();
  }
  const text = value.trim();
  if (text === '' || text.length > maxLength) {
    return undefined;
  }
  return text;
}

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

export function addUtcCalendarDays(isoDate: string, offset: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day + offset));
  return [
    String(utc.getUTCFullYear()).padStart(4, '0'),
    String(utc.getUTCMonth() + 1).padStart(2, '0'),
    String(utc.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(5, 7)) - 1,
    Number(endDate.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000) + 1;
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value.trim()) || value.trim() !== value) {
    invalidRequest();
  }
  return value;
}

function isFiniteGeoPoint(value: unknown): value is GeoPoint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.latitude === 'number'
    && Number.isFinite(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && typeof value.longitude === 'number'
    && Number.isFinite(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180
  );
}

function cloneGeoPoint(point: GeoPoint): GeoPoint {
  return { latitude: point.latitude, longitude: point.longitude };
}

function cloneTransport(transport: TransportSegment): TransportSegment {
  const cloned: TransportSegment = {
    mode: transport.mode,
    durationMinutes: transport.durationMinutes,
    distanceMeters: transport.distanceMeters,
  };
  if (transport.description !== undefined) {
    cloned.description = transport.description;
  }
  return cloned;
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

function readPlace(value: unknown): Place {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const id = readNonEmptyString(value.id, MAX_ID_LENGTH);
  if (typeof value.provider !== 'string' || (value.provider !== 'amap' && value.provider !== 'mock')) {
    invalidRequest();
  }
  if (typeof value.category !== 'string' || !PLACE_TYPES.has(value.category as TripPlaceType)) {
    invalidRequest();
  }
  if (typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
    invalidRequest();
  }
  return {
    id,
    provider: value.provider,
    providerPlaceId: readNonEmptyString(value.providerPlaceId, MAX_ID_LENGTH),
    name: readNonEmptyString(value.name),
    address: typeof value.address === 'string' ? value.address : invalidRequest(),
    latitude: value.latitude,
    longitude: value.longitude,
    category: value.category as TripPlaceType,
  };
}

function readStop(value: unknown): ResolvedTripPlaceStop {
  if (!isRecord(value)) {
    invalidRequest();
  }
  if (typeof value.suggestedStartTime !== 'string' || !CLOCK_TIME.test(value.suggestedStartTime.trim())) {
    invalidRequest();
  }
  if (
    typeof value.suggestedDurationMinutes !== 'number'
    || !Number.isInteger(value.suggestedDurationMinutes)
    || value.suggestedDurationMinutes < 1
  ) {
    invalidRequest();
  }
  return {
    place: readPlace(value.place),
    category: 'sight',
    suggestedStartTime: value.suggestedStartTime.trim(),
    suggestedDurationMinutes: value.suggestedDurationMinutes,
    reason: readNonEmptyString(value.reason, MAX_SUMMARY_LENGTH),
    sourceQuery: readNonEmptyString(value.sourceQuery),
  };
}

function readTransport(value: unknown): TransportSegment {
  if (!isRecord(value) || typeof value.mode !== 'string' || !TRANSPORT_MODES.has(value.mode)) {
    invalidRequest();
  }
  if (
    typeof value.durationMinutes !== 'number'
    || !Number.isFinite(value.durationMinutes)
    || value.durationMinutes < 0
    || typeof value.distanceMeters !== 'number'
    || !Number.isFinite(value.distanceMeters)
    || value.distanceMeters < 0
  ) {
    invalidRequest();
  }
  const transport: TransportSegment = {
    mode: value.mode as TransportSegment['mode'],
    durationMinutes: value.durationMinutes,
    distanceMeters: value.distanceMeters,
  };
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') {
      invalidRequest();
    }
    transport.description = value.description;
  }
  return transport;
}

function readSuccessfulRoute(value: unknown): EnrichedTripRoute {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const fromPlaceId = readNonEmptyString(value.fromPlaceId, MAX_ID_LENGTH);
  const toPlaceId = readNonEmptyString(value.toPlaceId, MAX_ID_LENGTH);
  if (fromPlaceId === toPlaceId) {
    invalidRequest();
  }
  if (!Array.isArray(value.polyline) || value.polyline.length < 2) {
    invalidRequest();
  }
  if (!value.polyline.every((point) => isFiniteGeoPoint(point))) {
    invalidRequest();
  }
  return {
    fromPlaceId,
    toPlaceId,
    transport: readTransport(value.transport),
    polyline: value.polyline.map((point) => cloneGeoPoint(point)),
  };
}

function readUnresolvedRoute(value: unknown): UnresolvedTripRoute {
  if (!isRecord(value)) {
    invalidRequest();
  }
  if (
    value.reason !== 'MISSING_COORDINATES'
    && value.reason !== 'ROUTE_UNAVAILABLE'
    && value.reason !== 'INVALID_ROUTE_RESULT'
  ) {
    invalidRequest();
  }
  return {
    fromPlaceId: readNonEmptyString(value.fromPlaceId, MAX_ID_LENGTH),
    toPlaceId: readNonEmptyString(value.toPlaceId, MAX_ID_LENGTH),
    reason: value.reason,
  };
}

function readPlanDay(value: unknown, expectedDayNumber: number): RouteEnrichedTripPlanDay {
  if (!isRecord(value) || value.dayNumber !== expectedDayNumber) {
    invalidRequest();
  }
  if (!Array.isArray(value.stops) || !Array.isArray(value.routes) || !Array.isArray(value.unresolvedRoutes)) {
    invalidRequest();
  }
  const stops = value.stops.map((stop) => readStop(stop));
  const usedIds = new Set<string>();
  for (const stop of stops) {
    if (usedIds.has(stop.place.id)) {
      invalidRequest();
    }
    usedIds.add(stop.place.id);
  }
  const stopIds = new Set(stops.map((stop) => stop.place.id));
  const routes = value.routes.map((route) => {
    const parsed = readSuccessfulRoute(route);
    if (!stopIds.has(parsed.fromPlaceId) || !stopIds.has(parsed.toPlaceId)) {
      invalidRequest();
    }
    return parsed;
  });
  return {
    dayNumber: expectedDayNumber,
    title: readNonEmptyString(value.title),
    summary: readNonEmptyString(value.summary, MAX_SUMMARY_LENGTH),
    stops,
    routes,
    unresolvedRoutes: value.unresolvedRoutes.map((item) => readUnresolvedRoute(item)),
  };
}

function parseBuildInput(input: BuildTripInput): {
  requirement: ConfirmedTripRequirement;
  plan: RouteEnrichedTripPlanSuggestion;
  tripId: string;
  userId: string;
  createdAt: string;
} {
  if (!isRecord(input)) {
    invalidRequest();
  }
  const requirement = parseConfirmedTripRequirement(input.requirement);
  if (!requirement) {
    invalidRequest();
  }
  if (
    requirement.startDate
    && requirement.endDate
    && inclusiveDayCount(requirement.startDate, requirement.endDate) !== requirement.durationDays
  ) {
    invalidRequest();
  }
  const tripId = readId(input.tripId);
  const userId = readId(input.userId);
  if (typeof input.createdAt !== 'string' || !ISO_TIMESTAMP.test(input.createdAt)) {
    invalidRequest();
  }
  const parsedCreatedAt = new Date(input.createdAt);
  if (Number.isNaN(parsedCreatedAt.getTime())) {
    invalidRequest();
  }
  const planValue = input.plan;
  if (!isRecord(planValue) || !Array.isArray(planValue.days) || !Array.isArray(planValue.unresolved)) {
    invalidRequest();
  }
  if (planValue.days.length !== requirement.durationDays) {
    invalidRequest();
  }
  const days = planValue.days.map((day, index) => readPlanDay(day, index + 1));
  return {
    requirement,
    tripId,
    userId,
    createdAt: input.createdAt,
    plan: {
      title: typeof planValue.title === 'string' ? planValue.title : invalidRequest(),
      summary: typeof planValue.summary === 'string' ? planValue.summary : invalidRequest(),
      days,
      unresolved: planValue.unresolved.map((item) => {
        if (!isRecord(item)) {
          invalidRequest();
        }
        return {
          dayNumber: typeof item.dayNumber === 'number' ? item.dayNumber : invalidRequest(),
          name: readNonEmptyString(item.name),
          query: readNonEmptyString(item.query),
          reason: 'NO_MATCH',
        };
      }),
    },
  };
}

function tripTitle(requirement: ConfirmedTripRequirement, planTitle: string): string {
  const title = planTitle.trim();
  if (title !== '' && title.length <= MAX_TITLE_LENGTH) {
    return title;
  }
  return `${requirement.destination} ${requirement.durationDays} 天游`;
}

function clonePreferences(requirement: ConfirmedTripRequirement): TripPreference {
  const preferences = requirement.preferences;
  return {
    interests: preferences?.interests ? [...preferences.interests] : [],
    ...(preferences?.accommodation ? { accommodation: [...preferences.accommodation] } : {}),
    ...(preferences?.mustVisit ? { mustVisit: [...preferences.mustVisit] } : {}),
    ...(preferences?.avoid ? { avoid: [...preferences.avoid] } : {}),
  };
}

function tripPlanningContextFromRequirement(
  requirement: ConfirmedTripRequirement,
): TripPlanningContextV1 | undefined {
  const context: TripPlanningContextV1 = {};
  if (requirement.tripIntent) context.tripIntent = structuredClone(requirement.tripIntent);
  if (requirement.partyContext) context.partyContext = structuredClone(requirement.partyContext);
  if (requirement.constraints) context.constraints = structuredClone(requirement.constraints);
  return Object.keys(context).length > 0 ? context : undefined;
}

function dayDate(requirement: ConfirmedTripRequirement, dayNumber: number): string {
  if (!requirement.startDate) {
    return '';
  }
  return addUtcCalendarDays(requirement.startDate, dayNumber - 1);
}

function withoutHotelStops(day: RouteEnrichedTripPlanDay): RouteEnrichedTripPlanDay {
  const stops = day.stops.filter((stop) => stop.place.category !== 'hotel');
  const ids = new Set(stops.map((stop) => stop.place.id));
  return {
    ...day,
    stops,
    routes: day.routes.filter((route) => ids.has(route.fromPlaceId) && ids.has(route.toPlaceId)),
  };
}

function buildDayPlaces(
  tripId: string,
  dayId: string,
  day: RouteEnrichedTripPlanDay,
): TripPlace[] {
  const nextByFromId = new Map<string, EnrichedTripRoute>();
  for (const route of day.routes) {
    const fromIndex = day.stops.findIndex((stop) => stop.place.id === route.fromPlaceId);
    const toIndex = day.stops.findIndex((stop) => stop.place.id === route.toPlaceId);
    if (fromIndex >= 0 && toIndex === fromIndex + 1 && !nextByFromId.has(route.fromPlaceId)) {
      nextByFromId.set(route.fromPlaceId, route);
    }
  }

  return day.stops.map((stop, index) => {
    const order = index + 1;
    const place = clonePlace(stop.place);
    const nextRoute = nextByFromId.get(place.id);
    const tripPlace: TripPlace = {
      id: `${tripId}:day:${day.dayNumber}:stop:${order}`,
      dayId,
      order,
      placeId: place.id,
      placeName: place.name,
      type: place.category,
      startTime: stop.suggestedStartTime,
      durationMinutes: stop.suggestedDurationMinutes,
      description: stop.reason,
      estimatedCost: 0,
    };
    if (nextRoute) {
      tripPlace.transportToNext = cloneTransport(nextRoute.transport);
    }
    return tripPlace;
  });
}

function buildDayRoutes(
  tripId: string,
  dayId: string,
  day: RouteEnrichedTripPlanDay,
  places: TripPlace[],
): TripRoute[] {
  const tripPlaceIdByPlaceId = new Map(places.map((place) => [place.placeId, place.id]));
  return day.routes.map((route, index) => ({
    id: `${tripId}:day:${day.dayNumber}:route:${index + 1}`,
    dayId,
    fromTripPlaceId: tripPlaceIdByPlaceId.get(route.fromPlaceId) as string,
    toTripPlaceId: tripPlaceIdByPlaceId.get(route.toPlaceId) as string,
    transport: cloneTransport(route.transport),
    polyline: route.polyline.map((point) => cloneGeoPoint(point)),
  }));
}

function collectReferencedPlaces(trip: Trip, plan: RouteEnrichedTripPlanSuggestion): Place[] {
  const referenced = new Set(
    trip.days.flatMap((day) => day.places.map((item) => item.placeId)),
  );
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      if (!referenced.has(stop.place.id) || seen.has(stop.place.id)) {
        continue;
      }
      seen.add(stop.place.id);
      places.push(clonePlace(stop.place));
    }
  }
  return places;
}

export class ConfirmedTripBuilder implements TripBuilder {
  build(input: BuildTripInput): TripBuildResult {
    const parsed = parseBuildInput(input);
    const { requirement, plan, tripId, userId, createdAt } = parsed;
    const days: TripDay[] = [];
    const routes: TripRoute[] = [];

    for (const rawDay of plan.days) {
      const planDay = withoutHotelStops(rawDay);
      const dayId = `${tripId}:day:${planDay.dayNumber}`;
      const places = buildDayPlaces(tripId, dayId, planDay);
      const planned = planDaySchedule({
        dayId,
        destination: requirement.destination,
        pace: requirement.pace,
        diningMode: requirement.diningMode,
        places,
        dayNumber: planDay.dayNumber,
        dayTitle: planDay.title,
        planningPolicy: input.planningPolicy,
      });
      const scheduledById = new Map(planned.places.map((place) => [place.id, place]));
      for (const place of places) {
        const scheduled = scheduledById.get(place.id);
        if (scheduled?.startTime) {
          place.startTime = scheduled.startTime;
        }
        if (typeof scheduled?.durationMinutes === 'number') {
          place.durationMinutes = scheduled.durationMinutes;
        }
      }
      const day: TripDay = {
        id: dayId,
        tripId,
        dayNumber: planDay.dayNumber,
        date: dayDate(requirement, planDay.dayNumber),
        places,
        scheduleItems: planned.items,
      };
      const title = readOptionalText(planDay.title, MAX_TITLE_LENGTH);
      const summary = readOptionalText(planDay.summary, MAX_SUMMARY_LENGTH) ?? FALLBACK_DAY_SUMMARY;
      if (title) {
        day.title = title;
      }
      day.summary = summary;
      days.push(day);
      routes.push(...buildDayRoutes(tripId, dayId, planDay, places));
    }

    const trip: Trip = {
      id: tripId,
      userId,
      title: tripTitle(requirement, plan.title),
      destination: requirement.destination,
      travelerCount: requirement.travelerCount,
      totalBudget: requirement.totalBudget,
      currency: 'CNY',
      pace: requirement.pace ?? 'balanced',
      preferences: clonePreferences(requirement),
      status: 'PLANNING',
      days,
      routes,
      createdAt,
      updatedAt: createdAt,
    };
    if (requirement.origin) {
      trip.origin = requirement.origin;
    }
    if (requirement.startDate) {
      trip.startDate = requirement.startDate;
    }
    if (requirement.endDate) {
      trip.endDate = requirement.endDate;
    }
    const planningContext = tripPlanningContextFromRequirement(requirement);
    if (planningContext) {
      trip.planningContext = planningContext;
    }

    return {
      trip,
      places: collectReferencedPlaces(trip, plan),
      diagnostics: {
        unresolvedPlacesCount: plan.unresolved.length,
        unresolvedRoutesCount: plan.days.reduce(
          (count, day) => count + day.unresolvedRoutes.length,
          0,
        ),
      },
    };
  }
}
