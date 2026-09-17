import { AmapProviderError } from './amap-http-client';
import { TripBuilderError, type TripBuildDiagnostics, type TripBuilder } from './trip-builder';
import {
  ConfirmedTripRequirement,
  hasExplicitTravelPreferences,
  TripPlanGenerator,
} from './trip-plan-generator';
import type {
  ResolvedTripPlanDay,
  ResolvedTripPlanSuggestion,
  TripPlaceResolver,
} from './trip-place-resolver';
import type {
  RouteEnrichedTripPlanSuggestion,
  TripRouteEnricher,
} from './trip-route-enricher';
import { TRIP_ROUTE_ENRICH_BUDGET_MS } from './trip-route-enricher';
import { completeEnrichedTripPlan } from './trip-day-completion-resolver';
import {
  completeResolvedTripCorePlaces,
  dayNeedsCorePlaceCompletion,
} from './trip-core-place-completion-resolver';
import { isCoreTripPlace } from './trip-day-density-planner';
import { validateDayItineraryCompleteness } from './trip-itinerary-completeness-validator';
import type { PlaceSearchService } from './trip-place-resolver';
import { applyResolvedTripStopDurations } from './trip-stop-duration-resolver';
import { scheduleEnrichedTripTimes, TripTimeScheduleError } from './trip-time-scheduler';
import type { Place, Trip } from '../../src/domain/trip/types';
import {
  createGenerationRequestId,
  safeGenerationErrorCode,
  safeGenerationValidationReason,
  type GenerationStage,
  type GenerationStageLogger,
  type GenerationStageOutcome,
} from './generation-logger';

export const TRIP_GENERATION_INCOMPLETE_MESSAGE = '暂时无法补全这一天的可执行安排，请稍后重试或补充偏好。';
export const TRIP_GENERATION_TIMEOUT_MESSAGE = '行程生成时间较长，请稍后重试。';
export const TRIP_GENERATION_BUDGET_MS = 105_000;

export class TripGenerationIncompleteError extends Error {
  readonly code = 'TRIP_GENERATION_INCOMPLETE' as const;

  constructor(message = TRIP_GENERATION_INCOMPLETE_MESSAGE) {
    super(message);
    this.name = 'TripGenerationIncompleteError';
  }
}

export class TripGenerationTimeoutError extends Error {
  readonly code = 'TRIP_GENERATION_TIMEOUT' as const;

  constructor(message = TRIP_GENERATION_TIMEOUT_MESSAGE) {
    super(message);
    this.name = 'TripGenerationTimeoutError';
  }
}

export interface TripIdentity {
  createTripId(): string;
  nowIso(): string;
}

export interface TripGenerationResult {
  trip: Trip;
  places: Place[];
  diagnostics: TripBuildDiagnostics;
}

export interface TripGenerationOrchestrator {
  generate(input: {
    requirement: ConfirmedTripRequirement;
    tripId: string;
    createdAt: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<TripGenerationResult>;
}

export function createSystemTripIdentity(): TripIdentity {
  return {
    createTripId: () => `trip-${crypto.randomUUID()}`,
    nowIso: () => new Date().toISOString(),
  };
}

function isAmapRuntimeFailure(error: unknown): boolean {
  return (
    error instanceof AmapProviderError
    && (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_UNAVAILABLE')
  );
}

function assertResolvedCoverage(
  requirement: ConfirmedTripRequirement,
  resolved: ResolvedTripPlanSuggestion,
): void {
  if (resolved.days.length !== requirement.durationDays) {
    throw new TripGenerationIncompleteError();
  }
  for (const [index, day] of resolved.days.entries()) {
    // Day fallback may have already filled a partial day; require the final stop count.
    if (day.dayNumber !== index + 1 || day.stops.length < 2) {
      throw new TripGenerationIncompleteError();
    }
  }
}

function unresolvedAdjacentPairs(day: ResolvedTripPlanDay): RouteEnrichedTripPlanSuggestion['days'][number]['unresolvedRoutes'] {
  const pairs: RouteEnrichedTripPlanSuggestion['days'][number]['unresolvedRoutes'] = [];
  for (let index = 0; index < day.stops.length - 1; index += 1) {
    pairs.push({
      fromPlaceId: day.stops[index].place.id,
      toPlaceId: day.stops[index + 1].place.id,
      reason: 'ROUTE_UNAVAILABLE',
    });
  }
  return pairs;
}

function enrichedPlanWithoutRoutes(
  resolved: ResolvedTripPlanSuggestion,
): RouteEnrichedTripPlanSuggestion {
  const copy = structuredClone(resolved);
  return {
    title: copy.title,
    summary: copy.summary,
    unresolved: copy.unresolved,
    days: copy.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: day.stops,
      routes: [],
      unresolvedRoutes: unresolvedAdjacentPairs(day),
    })),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TripGenerationTimeoutError();
  }
}

export class ServerTripGenerationOrchestrator implements TripGenerationOrchestrator {
  constructor(
    private readonly deps: {
      planGenerator: TripPlanGenerator;
      placeResolver: TripPlaceResolver;
      routeEnricher: TripRouteEnricher;
      tripBuilder: TripBuilder;
      placeSearch?: PlaceSearchService;
      userId: string;
      logger?: GenerationStageLogger;
      budgetMs?: number;
      routeBudgetMs?: number;
    },
  ) {}

  async generate(input: {
    requirement: ConfirmedTripRequirement;
    tripId: string;
    createdAt: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<TripGenerationResult> {
    const requirement = structuredClone(input.requirement);
    const requestId = input.requestId ?? createGenerationRequestId();
    const budgetMs = this.deps.budgetMs ?? TRIP_GENERATION_BUDGET_MS;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (input.signal?.aborted) {
      controller.abort();
    } else {
      input.signal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const budgetTimer = setTimeout(() => controller.abort(), budgetMs);

    const log = (
      stage: GenerationStage,
      outcome: GenerationStageOutcome,
      startedAt: number,
      error?: unknown,
      validationReason?: string,
    ) => {
      const safeReason = validationReason
        ?? safeGenerationValidationReason(error);
      this.deps.logger?.logStage({
        requestId,
        stage,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(outcome === 'success' ? {} : { errorCode: safeGenerationErrorCode(error) ?? (outcome === 'timed_out' ? 'TRIP_GENERATION_TIMEOUT' : outcome === 'retried' ? 'AI_INVALID_RESPONSE' : 'INTERNAL_ERROR') }),
        ...(safeReason ? { validationReason: safeReason } : {}),
      });
    };

    const runStage = async <T>(
      stage: GenerationStage,
      work: () => Promise<T> | T,
    ): Promise<T> => {
      const startedAt = Date.now();
      try {
        throwIfAborted(controller.signal);
        const result = await work();
        throwIfAborted(controller.signal);
        if (
          stage === 'plan'
          && this.deps.planGenerator.lastPlanDiagnostics?.retried === true
        ) {
          log(
            stage,
            'retried',
            startedAt,
            { code: 'AI_INVALID_RESPONSE', validationReason: this.deps.planGenerator.lastPlanDiagnostics.validationReason },
          );
        } else {
          log(stage, 'success', startedAt);
        }
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          log(stage, 'timed_out', startedAt, new TripGenerationTimeoutError());
          throw new TripGenerationTimeoutError();
        }
        log(stage, 'failed', startedAt, error);
        throw error;
      }
    };

    try {
      const suggestion = await runStage('plan', async () => {
        const plan = await this.deps.planGenerator.generate(requirement, { signal: controller.signal });
        return plan;
      });

      const resolved = await runStage('place_resolve', async () => {
        const next = await this.deps.placeResolver.resolve({
          destination: requirement.destination,
          plan: suggestion,
          signal: controller.signal,
          hasExplicitTravelPreferences: hasExplicitTravelPreferences(requirement),
        });
        assertResolvedCoverage(requirement, next);
        const withDurations = applyResolvedTripStopDurations(next, {
          destination: requirement.destination,
          pace: requirement.pace,
        });
        if (!this.deps.placeSearch) {
          return withDurations;
        }
        const completed = await completeResolvedTripCorePlaces({
          plan: withDurations,
          destination: requirement.destination,
          pace: requirement.pace,
          placeSearch: this.deps.placeSearch,
          hasExplicitTravelPreferences: hasExplicitTravelPreferences(requirement),
          preferenceTerms: [
            ...(requirement.preferences?.interests ?? []),
            ...(requirement.preferences?.mustVisit ?? []),
          ],
          signal: controller.signal,
        });
        for (const day of completed.days) {
          if (dayNeedsCorePlaceCompletion(day, requirement.pace)) {
            throw new TripGenerationIncompleteError();
          }
        }
        return completed;
      });

      const enriched = await runStage('route_enrich', async () => {
        try {
          return await this.deps.routeEnricher.enrich({
            plan: resolved,
            pace: requirement.pace,
            signal: controller.signal,
            budgetMs: this.deps.routeBudgetMs ?? TRIP_ROUTE_ENRICH_BUDGET_MS,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw error;
          }
          if (isAmapRuntimeFailure(error)) {
            return enrichedPlanWithoutRoutes(resolved);
          }
          throw error;
        }
      });

      const scheduled = await runStage('time_schedule', () => {
        try {
          return scheduleEnrichedTripTimes(enriched);
        } catch (error) {
          if (error instanceof TripTimeScheduleError) {
            throw new TripBuilderError('INVALID_REQUEST', error.message);
          }
          throw error;
        }
      });

      return await runStage('trip_build', async () => {
        let plan = scheduled;
        if (this.deps.placeSearch) {
          try {
            plan = await completeEnrichedTripPlan({
              plan: scheduled,
              destination: requirement.destination,
              pace: requirement.pace,
              diningMode: requirement.diningMode,
              placeSearch: this.deps.placeSearch,
              routeEnricher: this.deps.routeEnricher,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) {
              throw new TripGenerationTimeoutError();
            }
            if (isAmapRuntimeFailure(error)) {
              throw error;
            }
            throw error;
          }
        }
        const built = this.deps.tripBuilder.build({
          requirement,
          plan,
          tripId: input.tripId,
          createdAt: input.createdAt,
          userId: this.deps.userId,
        });
        for (const day of built.trip.days) {
          if (day.places.length === 0) {
            continue;
          }
          const completeness = validateDayItineraryCompleteness({
            pace: built.trip.pace,
            placeIds: new Set(day.places.map((place) => place.id)),
            corePlaceCount: day.places.filter((place) => isCoreTripPlace(place)).length,
            items: day.scheduleItems ?? [],
            places: day.places,
          });
          if (!completeness.valid) {
            throw new TripGenerationIncompleteError();
          }
        }
        return built;
      });
    } finally {
      clearTimeout(budgetTimer);
      input.signal?.removeEventListener('abort', onParentAbort);
    }
  }
}
