import type { ResolvedTripPlaceStop } from './trip-place-resolver';
import type {
  EnrichedTripRoute,
  RouteEnrichedTripPlanDay,
  RouteEnrichedTripPlanSuggestion,
} from './trip-route-enricher';

export const TRIP_TIME_SCHEDULE_INVALID_REQUEST_MESSAGE = '行程时间编排请求无效，请调整后重试。';
export const DEFAULT_DAY_START_MINUTES = 10 * 60;
export const FIRST_STOP_LATEST_MINUTES = 11 * 60 + 30;
export const TRANSFER_BUFFER_MINUTES = 15;
export const MISSING_ROUTE_SCHEDULE_BUFFER_MINUTES = 30;
export const MAX_KEEP_AI_GAP_MINUTES = 90;
export const SCHEDULE_ROUND_MINUTES = 5;
export const MAX_CLOCK_MINUTES = 23 * 60 + 59;

export class TripTimeScheduleError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'TripTimeScheduleError';
  }
}

function invalidRequest(): never {
  throw new TripTimeScheduleError('INVALID_REQUEST', TRIP_TIME_SCHEDULE_INVALID_REQUEST_MESSAGE);
}

export function parseClockMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClockMinutes(totalMinutes: number): string {
  if (
    !Number.isInteger(totalMinutes)
    || totalMinutes < 0
    || totalMinutes > MAX_CLOCK_MINUTES
  ) {
    invalidRequest();
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function ceilToScheduleStep(totalMinutes: number): number {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) {
    invalidRequest();
  }
  return Math.ceil(totalMinutes / SCHEDULE_ROUND_MINUTES) * SCHEDULE_ROUND_MINUTES;
}

function cloneStop(stop: ResolvedTripPlaceStop): ResolvedTripPlaceStop {
  const cloned: ResolvedTripPlaceStop = {
    place: {
      id: stop.place.id,
      provider: stop.place.provider,
      providerPlaceId: stop.place.providerPlaceId,
      name: stop.place.name,
      address: stop.place.address,
      latitude: stop.place.latitude,
      longitude: stop.place.longitude,
      category: stop.place.category,
    },
    category: stop.category,
    suggestedStartTime: stop.suggestedStartTime,
    suggestedDurationMinutes: stop.suggestedDurationMinutes,
    reason: stop.reason,
    sourceQuery: stop.sourceQuery,
  };
  if (stop.resolutionSource) {
    cloned.resolutionSource = stop.resolutionSource;
  }
  return cloned;
}

function cloneRoute(route: EnrichedTripRoute): EnrichedTripRoute {
  const transport = {
    mode: route.transport.mode,
    durationMinutes: route.transport.durationMinutes,
    distanceMeters: route.transport.distanceMeters,
    ...(route.transport.description !== undefined
      ? { description: route.transport.description }
      : {}),
  };
  return {
    fromPlaceId: route.fromPlaceId,
    toPlaceId: route.toPlaceId,
    transport,
    polyline: route.polyline.map((point) => ({
      latitude: point.latitude,
      longitude: point.longitude,
    })),
  };
}

function cloneDay(day: RouteEnrichedTripPlanDay): RouteEnrichedTripPlanDay {
  return {
    dayNumber: day.dayNumber,
    title: day.title,
    summary: day.summary,
    stops: day.stops.map((stop) => cloneStop(stop)),
    routes: day.routes.map((route) => cloneRoute(route)),
    unresolvedRoutes: day.unresolvedRoutes.map((item) => ({
      fromPlaceId: item.fromPlaceId,
      toPlaceId: item.toPlaceId,
      reason: item.reason,
    })),
  };
}

function readDurationMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalidRequest();
  }
  return value;
}

function adjacentTransitMinutes(
  from: ResolvedTripPlaceStop,
  to: ResolvedTripPlaceStop,
  routes: readonly EnrichedTripRoute[],
): number {
  const route = routes.find((item) => (
    item.fromPlaceId === from.place.id && item.toPlaceId === to.place.id
  ));
  const duration = route?.transport.durationMinutes;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
    return duration;
  }
  return MISSING_ROUTE_SCHEDULE_BUFFER_MINUTES;
}

function scheduleFirstStop(stop: ResolvedTripPlaceStop): number {
  const suggested = parseClockMinutes(stop.suggestedStartTime);
  if (
    suggested !== undefined
    && suggested >= DEFAULT_DAY_START_MINUTES
    && suggested <= FIRST_STOP_LATEST_MINUTES
  ) {
    return suggested;
  }
  return DEFAULT_DAY_START_MINUTES;
}

function scheduleNextStop(
  previousStart: number,
  previousDuration: number,
  transitMinutes: number,
  suggestedStartTime: string,
): number {
  const earliest = ceilToScheduleStep(
    previousStart + previousDuration + transitMinutes + TRANSFER_BUFFER_MINUTES,
  );
  if (earliest > MAX_CLOCK_MINUTES) {
    invalidRequest();
  }
  const suggested = parseClockMinutes(suggestedStartTime);
  if (suggested === undefined || suggested < earliest) {
    return earliest;
  }
  if (suggested - earliest > MAX_KEEP_AI_GAP_MINUTES) {
    return earliest;
  }
  const kept = ceilToScheduleStep(suggested);
  if (kept > MAX_CLOCK_MINUTES) {
    invalidRequest();
  }
  return kept;
}

export function scheduleEnrichedTripDay(day: RouteEnrichedTripPlanDay): RouteEnrichedTripPlanDay {
  const scheduled = cloneDay(day);
  if (scheduled.stops.length === 0) {
    invalidRequest();
  }
  let previousStart = scheduleFirstStop(scheduled.stops[0]);
  scheduled.stops[0].suggestedStartTime = formatClockMinutes(previousStart);
  for (let index = 1; index < scheduled.stops.length; index += 1) {
    const previous = scheduled.stops[index - 1];
    const current = scheduled.stops[index];
    const nextStart = scheduleNextStop(
      previousStart,
      readDurationMinutes(previous.suggestedDurationMinutes),
      adjacentTransitMinutes(previous, current, scheduled.routes),
      current.suggestedStartTime,
    );
    current.suggestedStartTime = formatClockMinutes(nextStart);
    previousStart = nextStart;
  }
  readDurationMinutes(scheduled.stops[scheduled.stops.length - 1].suggestedDurationMinutes);
  return scheduled;
}

export function scheduleEnrichedTripTimes(
  plan: RouteEnrichedTripPlanSuggestion,
): RouteEnrichedTripPlanSuggestion {
  if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
    invalidRequest();
  }
  return {
    title: plan.title,
    summary: plan.summary,
    unresolved: plan.unresolved.map((item) => ({
      dayNumber: item.dayNumber,
      name: item.name,
      query: item.query,
      reason: item.reason,
    })),
    days: plan.days.map((day, index) => {
      if (day.dayNumber !== index + 1) {
        invalidRequest();
      }
      return scheduleEnrichedTripDay(day);
    }),
  };
}
