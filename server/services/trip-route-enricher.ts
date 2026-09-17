import type {
  GeoPoint,
  Place,
  TransportSegment,
  TripPace,
} from '../../src/domain/trip/types';
import { AmapProviderError } from './amap-http-client';
import type {
  AmapRouteService,
  RoutePlanningInput,
  RouteResult,
} from './amap-route-service';
import type {
  ResolvedTripPlaceStop,
  ResolvedTripPlanSuggestion,
  UnresolvedTripPlace,
} from './trip-place-resolver';
import type { TripPlanPlaceCategory } from './trip-plan-generator';

export type RoutePlanningService = Pick<AmapRouteService, 'plan'>;

export type UnresolvedTripRouteReason =
  | 'MISSING_COORDINATES'
  | 'ROUTE_UNAVAILABLE'
  | 'INVALID_ROUTE_RESULT';

export interface EnrichedTripRoute {
  fromPlaceId: string;
  toPlaceId: string;
  transport: TransportSegment;
  polyline: GeoPoint[];
}

export interface UnresolvedTripRoute {
  fromPlaceId: string;
  toPlaceId: string;
  reason: UnresolvedTripRouteReason;
}

export interface RouteEnrichedTripPlanDay {
  dayNumber: number;
  title: string;
  summary: string;
  stops: ResolvedTripPlaceStop[];
  routes: EnrichedTripRoute[];
  unresolvedRoutes: UnresolvedTripRoute[];
}

export interface RouteEnrichedTripPlanSuggestion {
  title: string;
  summary: string;
  days: RouteEnrichedTripPlanDay[];
  unresolved: UnresolvedTripPlace[];
}

export interface EnrichTripRoutesInput {
  plan: ResolvedTripPlanSuggestion;
  pace?: TripPace;
  signal?: AbortSignal;
  budgetMs?: number;
}

export interface TripRouteEnricher {
  enrich(input: EnrichTripRoutesInput): Promise<RouteEnrichedTripPlanSuggestion>;
}

export const TRIP_ROUTE_ENRICH_CONCURRENCY = 3;
export const TRIP_ROUTE_ENRICH_BUDGET_MS = 15_000;
export const EARTH_RADIUS_METERS = 6_371_000;
export const WALK_THRESHOLD_METERS = {
  relaxed: 2_000,
  balanced: 1_500,
  packed: 1_000,
} as const;

const INVALID_REQUEST_MESSAGE = '行程路线编排请求无效，请调整后重试。';
const PROVIDER_ERROR_MESSAGE = '路线服务暂时不可用，请稍后重试。';
const PACES = new Set<TripPace>(['relaxed', 'balanced', 'packed']);
const PLACE_CATEGORIES = new Set<TripPlanPlaceCategory>([
  'sight',
  'food',
  'coffee',
  'hotel',
  'shopping',
  'activity',
  'other',
]);
const UNRESOLVED_PLACE_REASONS = new Set([
  'NO_MATCH',
  'DUPLICATE_MATCH',
  'SEARCH_UNAVAILABLE',
]);

interface AdjacentRouteJob {
  dayIndex: number;
  fromPlaceId: string;
  toPlaceId: string;
  origin?: GeoPoint;
  destination?: GeoPoint;
  mode?: 'walk' | 'taxi';
  skipReason?: UnresolvedTripRouteReason;
}

interface RouteJobOutcome {
  route?: EnrichedTripRoute;
  unresolved?: UnresolvedTripRoute;
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

function isRouteUnavailable(error: unknown): boolean {
  return (
    error instanceof AmapProviderError
    && (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_UNAVAILABLE')
  );
}

export function isFiniteGeoPoint(value: unknown): value is GeoPoint {
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

export function haversineMeters(from: GeoPoint, to: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const chord =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

export function walkThresholdMeters(pace: TripPace | undefined): number {
  if (pace === 'relaxed') {
    return WALK_THRESHOLD_METERS.relaxed;
  }
  if (pace === 'packed') {
    return WALK_THRESHOLD_METERS.packed;
  }
  return WALK_THRESHOLD_METERS.balanced;
}

export function selectTransportMode(
  distanceMeters: number,
  pace?: TripPace,
): 'walk' | 'taxi' {
  return distanceMeters <= walkThresholdMeters(pace) ? 'walk' : 'taxi';
}

function cloneGeoPoint(point: GeoPoint): GeoPoint {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
  };
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

function readPace(value: unknown): TripPace | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !PACES.has(value as TripPace)) {
    invalidRequest();
  }
  return value as TripPace;
}

function readPlace(value: unknown): Place {
  if (!isRecord(value)) {
    invalidRequest();
  }
  const id = readNonEmptyString(value.id);
  if (typeof value.provider !== 'string' || (value.provider !== 'amap' && value.provider !== 'mock')) {
    invalidRequest();
  }
  if (typeof value.providerPlaceId !== 'string' || value.providerPlaceId.trim() === '') {
    invalidRequest();
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    invalidRequest();
  }
  if (typeof value.address !== 'string') {
    invalidRequest();
  }
  if (typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
    invalidRequest();
  }
  if (typeof value.category !== 'string') {
    invalidRequest();
  }
  return {
    id,
    provider: value.provider,
    providerPlaceId: value.providerPlaceId,
    name: value.name,
    address: value.address,
    latitude: value.latitude,
    longitude: value.longitude,
    category: value.category as Place['category'],
  };
}

function readStop(value: unknown): ResolvedTripPlaceStop {
  if (!isRecord(value)) {
    invalidRequest();
  }
  if (typeof value.category !== 'string' || !PLACE_CATEGORIES.has(value.category as TripPlanPlaceCategory)) {
    invalidRequest();
  }
  if (typeof value.suggestedStartTime !== 'string' || value.suggestedStartTime.trim() === '') {
    invalidRequest();
  }
  if (
    typeof value.suggestedDurationMinutes !== 'number'
    || !Number.isInteger(value.suggestedDurationMinutes)
  ) {
    invalidRequest();
  }
  return {
    place: readPlace(value.place),
    category: value.category as TripPlanPlaceCategory,
    suggestedStartTime: value.suggestedStartTime,
    suggestedDurationMinutes: value.suggestedDurationMinutes,
    reason: readNonEmptyString(value.reason),
    sourceQuery: readNonEmptyString(value.sourceQuery),
  };
}

function readUnresolvedPlace(value: unknown): UnresolvedTripPlace {
  if (!isRecord(value)) {
    invalidRequest();
  }
  if (typeof value.dayNumber !== 'number' || !Number.isInteger(value.dayNumber)) {
    invalidRequest();
  }
  if (typeof value.reason !== 'string' || !UNRESOLVED_PLACE_REASONS.has(value.reason)) {
    invalidRequest();
  }
  return {
    dayNumber: value.dayNumber,
    name: readNonEmptyString(value.name),
    query: readNonEmptyString(value.query),
    reason: value.reason as UnresolvedTripPlace['reason'],
  };
}

function parseEnrichInput(input: EnrichTripRoutesInput): {
  plan: ResolvedTripPlanSuggestion;
  pace?: TripPace;
} {
  if (!isRecord(input)) {
    invalidRequest();
  }
  const pace = readPace(input.pace);
  const plan = input.plan;
  if (!isRecord(plan) || !Array.isArray(plan.days) || !Array.isArray(plan.unresolved)) {
    invalidRequest();
  }
  const usedPlaceIds = new Set<string>();
  const days = plan.days.map((day, index) => {
    if (!isRecord(day)) {
      invalidRequest();
    }
    const expectedDayNumber = index + 1;
    if (day.dayNumber !== expectedDayNumber) {
      invalidRequest();
    }
    if (!Array.isArray(day.stops)) {
      invalidRequest();
    }
    const stops = day.stops.map((stop) => {
      const parsed = readStop(stop);
      if (usedPlaceIds.has(parsed.place.id)) {
        invalidRequest();
      }
      usedPlaceIds.add(parsed.place.id);
      return parsed;
    });
    return {
      dayNumber: expectedDayNumber,
      title: readNonEmptyString(day.title),
      summary: readNonEmptyString(day.summary),
      stops,
    };
  });
  return {
    pace,
    plan: {
      title: readNonEmptyString(plan.title),
      summary: readNonEmptyString(plan.summary),
      days,
      unresolved: plan.unresolved.map((item) => readUnresolvedPlace(item)),
    },
  };
}

function cloneStop(stop: ResolvedTripPlaceStop): ResolvedTripPlaceStop {
  return {
    place: clonePlace(stop.place),
    category: stop.category,
    suggestedStartTime: stop.suggestedStartTime,
    suggestedDurationMinutes: stop.suggestedDurationMinutes,
    reason: stop.reason,
    sourceQuery: stop.sourceQuery,
  };
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

function readValidRouteResult(value: unknown): RouteResult | undefined {
  if (!isRecord(value) || !isRecord(value.transport) || !Array.isArray(value.polyline)) {
    return undefined;
  }
  const mode = value.transport.mode;
  if (mode !== 'walk' && mode !== 'taxi') {
    return undefined;
  }
  if (
    typeof value.transport.durationMinutes !== 'number'
    || !Number.isFinite(value.transport.durationMinutes)
    || value.transport.durationMinutes < 0
    || typeof value.transport.distanceMeters !== 'number'
    || !Number.isFinite(value.transport.distanceMeters)
    || value.transport.distanceMeters < 0
  ) {
    return undefined;
  }
  if (value.polyline.length < 2 || !value.polyline.every((point) => isFiniteGeoPoint(point))) {
    return undefined;
  }
  const transport: TransportSegment = {
    mode,
    durationMinutes: value.transport.durationMinutes,
    distanceMeters: value.transport.distanceMeters,
  };
  if (typeof value.transport.description === 'string') {
    transport.description = value.transport.description;
  }
  return {
    transport,
    polyline: value.polyline.map((point) => cloneGeoPoint(point)),
  };
}

function buildJobs(
  days: ResolvedTripPlanSuggestion['days'],
  pace: TripPace | undefined,
): AdjacentRouteJob[] {
  const jobs: AdjacentRouteJob[] = [];
  for (const [dayIndex, day] of days.entries()) {
    for (let index = 0; index < day.stops.length - 1; index += 1) {
      const from = day.stops[index].place;
      const to = day.stops[index + 1].place;
      const origin = isFiniteGeoPoint(from) ? cloneGeoPoint(from) : undefined;
      const destination = isFiniteGeoPoint(to) ? cloneGeoPoint(to) : undefined;
      if (!origin || !destination) {
        jobs.push({
          dayIndex,
          fromPlaceId: from.id,
          toPlaceId: to.id,
          skipReason: 'MISSING_COORDINATES',
        });
        continue;
      }
      jobs.push({
        dayIndex,
        fromPlaceId: from.id,
        toPlaceId: to.id,
        origin,
        destination,
        mode: selectTransportMode(haversineMeters(origin, destination), pace),
      });
    }
  }
  return jobs;
}

export class AmapTripRouteEnricher implements TripRouteEnricher {
  constructor(
    private readonly routeService: RoutePlanningService,
    private readonly budgetMs = TRIP_ROUTE_ENRICH_BUDGET_MS,
  ) {}

  async enrich(input: EnrichTripRoutesInput): Promise<RouteEnrichedTripPlanSuggestion> {
    const parsed = parseEnrichInput(input);
    const jobs = buildJobs(parsed.plan.days, parsed.pace);
    const plannedJobs = jobs
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.skipReason === undefined);

    const outcomes: RouteJobOutcome[] = jobs.map((job) => (
      job.skipReason
        ? {
            unresolved: {
              fromPlaceId: job.fromPlaceId,
              toPlaceId: job.toPlaceId,
              reason: job.skipReason,
            },
          }
        : {}
    ));

    const routeController = new AbortController();
    const parentSignal = input.signal;
    const onParentAbort = () => routeController.abort();
    if (parentSignal?.aborted) {
      routeController.abort();
    } else {
      parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const budgetMs = input.budgetMs ?? this.budgetMs;
    const timer = setTimeout(() => routeController.abort(), budgetMs);

    const unavailable = (job: AdjacentRouteJob): RouteJobOutcome => ({
      unresolved: {
        fromPlaceId: job.fromPlaceId,
        toPlaceId: job.toPlaceId,
        reason: 'ROUTE_UNAVAILABLE',
      },
    });

    try {
      const plannedOutcomes = await mapWithConcurrency(
        plannedJobs,
        TRIP_ROUTE_ENRICH_CONCURRENCY,
        async ({ job }) => {
          if (routeController.signal.aborted) {
            return unavailable(job);
          }
          const planningInput: RoutePlanningInput = {
            origin: cloneGeoPoint(job.origin as GeoPoint),
            destination: cloneGeoPoint(job.destination as GeoPoint),
            mode: job.mode as 'walk' | 'taxi',
            signal: routeController.signal,
          };
          try {
            const result = await this.routeService.plan(planningInput);
            if (parentSignal?.aborted) {
              throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
            }
            if (routeController.signal.aborted) {
              return unavailable(job);
            }
            const valid = readValidRouteResult(result);
            if (!valid) {
              return {
                unresolved: {
                  fromPlaceId: job.fromPlaceId,
                  toPlaceId: job.toPlaceId,
                  reason: 'INVALID_ROUTE_RESULT' as const,
                },
              };
            }
            return {
              route: {
                fromPlaceId: job.fromPlaceId,
                toPlaceId: job.toPlaceId,
                transport: cloneTransport(valid.transport),
                polyline: valid.polyline.map((point) => cloneGeoPoint(point)),
              },
            };
          } catch (error) {
            if (parentSignal?.aborted) {
              if (error instanceof AmapProviderError) {
                throw error;
              }
              providerError();
            }
            if (isRouteUnavailable(error) || routeController.signal.aborted) {
              return unavailable(job);
            }
            if (error instanceof AmapProviderError) {
              throw new AmapProviderError(
                error.code,
                error.code === 'INVALID_REQUEST'
                  ? INVALID_REQUEST_MESSAGE
                  : PROVIDER_ERROR_MESSAGE,
              );
            }
            providerError();
          }
        },
      );
      plannedJobs.forEach(({ index }, plannedIndex) => {
        outcomes[index] = plannedOutcomes[plannedIndex] ?? unavailable(jobs[index]);
      });
    } catch (error) {
      if (parentSignal?.aborted) {
        throw error;
      }
      if (routeController.signal.aborted) {
        plannedJobs.forEach(({ index, job }) => {
          if (!outcomes[index].route && !outcomes[index].unresolved) {
            outcomes[index] = unavailable(job);
          }
        });
      } else if (error instanceof AmapProviderError) {
        throw error;
      } else {
        providerError();
      }
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }

    const days: RouteEnrichedTripPlanDay[] = parsed.plan.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: day.stops.map((stop) => cloneStop(stop)),
      routes: [],
      unresolvedRoutes: [],
    }));

    jobs.forEach((job, index) => {
      const outcome = outcomes[index];
      if (outcome.route) {
        days[job.dayIndex].routes.push(outcome.route);
        return;
      }
      if (outcome.unresolved) {
        days[job.dayIndex].unresolvedRoutes.push(outcome.unresolved);
      } else {
        days[job.dayIndex].unresolvedRoutes.push({
          fromPlaceId: job.fromPlaceId,
          toPlaceId: job.toPlaceId,
          reason: 'ROUTE_UNAVAILABLE',
        });
      }
    });

    return {
      title: parsed.plan.title,
      summary: parsed.plan.summary,
      days,
      unresolved: parsed.plan.unresolved.map((item) => ({ ...item })),
    };
  }
}
