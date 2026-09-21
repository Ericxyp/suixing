import type { Place, Trip } from '../domain/trip/types';
import type { TripRepository } from '../repositories/trip-repository';
import { BffClientError, type FetchLike } from './bff-client';
import type { SelectMealPlaceSummary } from './bff-trip-meal-service';
import {
  BffTripChangeService,
  isReadyReplaceIntent,
  type ReplacePlaceOperation,
  type ReplacePlaceSummary,
  type TripChangeApplyResult,
  type TripChangeApplyService,
  type TripChangeFocus,
  type TripChangeIntent,
  type TripChangeInterpretService,
} from './bff-trip-change-service';

export const TRIP_CHANGE_INVALID_NOTICE = '这次调整暂时无法理解，请换一种说法。';
export const TRIP_CHANGE_INCOMPLETE_NOTICE = '暂时找不到合适的替换地点，请换一种说法后重试。';
export const TRIP_CHANGE_PROVIDER_ERROR_NOTICE = '地点与路线服务暂时不可用，请稍后重试。';
export const TRIP_CHANGE_UNAVAILABLE_NOTICE = '修改服务尚未配置，请稍后再试。';
export const TRIP_CHANGE_GENERIC_NOTICE = '暂时无法调整行程，请稍后重试。';
export const TRIP_CHANGE_STALE_NOTICE = '当前行程已变化，请重新说明这次调整。';
export const TRIP_CHANGE_SAVE_FAILED_NOTICE = '暂时无法保存行程修改，请重试。';
export const TRIP_CHANGE_UNDO_FAILED_NOTICE = '暂时无法撤销本次调整，请重试。';
export const TRIP_CHANGE_UNDONE_NOTICE = '已撤销本次调整';
export const UNDO_TOAST_MS = 10_000;

export function isUndoToastActive(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs < UNDO_TOAST_MS;
}

export type TripChangeOutcome =
  | { status: 'needs_clarification'; summary: string; intent: TripChangeIntent }
  | { status: 'needs_choice'; summary: string; intent: TripChangeIntent }
  | { status: 'applied'; result: TripChangeApplyResult };

export interface TripChangeService {
  interpret(input: string, trip: Trip, focus?: TripChangeFocus): Promise<TripChangeIntent>;
  apply(input: {
    trip: Trip;
    places: Place[];
    operation: ReplacePlaceOperation;
    expectedTripId: string;
  }): Promise<TripChangeApplyResult>;
  requestChange(input: {
    text: string;
    trip: Trip;
    places: Place[];
    expectedTripId: string;
  }): Promise<TripChangeOutcome>;
}

export class TripChangeStaleError extends Error {
  constructor(message = TRIP_CHANGE_STALE_NOTICE) {
    super(message);
    this.name = 'TripChangeStaleError';
  }
}

export function isSemanticTripChangeError(error: unknown): boolean {
  return error instanceof BffClientError
    && (error.code === 'INVALID_REQUEST' || error.code === 'AI_INVALID_REQUEST');
}

export function noticeForTripChangeError(error: unknown): string {
  if (error instanceof TripChangeStaleError) {
    return TRIP_CHANGE_STALE_NOTICE;
  }
  if (error instanceof BffClientError) {
    if (error.code === 'INVALID_REQUEST' || error.code === 'AI_INVALID_REQUEST') {
      return TRIP_CHANGE_INVALID_NOTICE;
    }
    if (error.code === 'TRIP_CHANGE_INCOMPLETE') {
      return TRIP_CHANGE_INCOMPLETE_NOTICE;
    }
    if (error.code === 'PROVIDER_ERROR' || error.code === 'AI_PROVIDER_ERROR') {
      return TRIP_CHANGE_PROVIDER_ERROR_NOTICE;
    }
    if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'AI_PROVIDER_UNAVAILABLE') {
      return TRIP_CHANGE_UNAVAILABLE_NOTICE;
    }
  }
  return TRIP_CHANGE_GENERIC_NOTICE;
}

export function appliedToastLabel(summary: ReplacePlaceSummary | SelectMealPlaceSummary): string {
  if (summary.type === 'SELECT_MEAL_PLACE') {
    return `已加入「${summary.nextPlaceName}」`;
  }
  return `已将「${summary.previousPlaceName}」替换为「${summary.nextPlaceName}」`;
}

export class AutoApplyTripChangeService implements TripChangeService {
  constructor(
    private readonly interpretService: TripChangeInterpretService,
    private readonly applyService: TripChangeApplyService,
  ) {}

  async interpret(input: string, trip: Trip, focus?: TripChangeFocus): Promise<TripChangeIntent> {
    return this.interpretService.interpret(input, trip, focus);
  }

  async apply(input: {
    trip: Trip;
    places: Place[];
    operation: ReplacePlaceOperation;
    expectedTripId: string;
  }): Promise<TripChangeApplyResult> {
    return this.applyService.apply(input);
  }

  async requestChange(input: {
    text: string;
    trip: Trip;
    places: Place[];
    expectedTripId: string;
  }): Promise<TripChangeOutcome> {
    if (input.trip.id !== input.expectedTripId) {
      throw new TripChangeStaleError();
    }
    const intent = await this.interpretService.interpret(input.text, input.trip);
    if (intent.status === 'needs_choice') {
      return { status: 'needs_choice', summary: intent.summary, intent };
    }
    if (intent.status === 'needs_clarification' || !isReadyReplaceIntent(intent)) {
      return { status: 'needs_clarification', summary: intent.summary, intent };
    }
    if (input.trip.id !== input.expectedTripId) {
      throw new TripChangeStaleError();
    }
    const result = await this.applyService.apply({
      trip: input.trip,
      places: input.places,
      operation: intent.operations[0],
      expectedTripId: input.expectedTripId,
    });
    return { status: 'applied', result };
  }
}

export function createTripChangeService(fetchImpl?: FetchLike): TripChangeService {
  const bff = new BffTripChangeService(fetchImpl);
  return new AutoApplyTripChangeService(bff, bff);
}

export async function persistAppliedTripChange(
  repository: TripRepository,
  input: {
    currentTripId: string;
    trip: Trip;
    places: Place[];
  },
): Promise<{ trip: Trip; places: Place[] }> {
  if (input.trip.id !== input.currentTripId) {
    throw new TripChangeStaleError();
  }
  await repository.saveGeneratedTrip({
    trip: input.trip,
    places: input.places,
  });
  return {
    trip: structuredClone(input.trip),
    places: structuredClone(input.places),
  };
}

export async function restoreTripChangeSnapshot(
  repository: TripRepository,
  snapshot: { trip: Trip; places: Place[] } | null,
  currentTripId: string,
): Promise<{ trip: Trip; places: Place[] }> {
  if (!snapshot || snapshot.trip.id !== currentTripId) {
    throw new TripChangeStaleError();
  }
  await repository.saveGeneratedTrip({
    trip: snapshot.trip,
    places: snapshot.places,
  });
  return {
    trip: structuredClone(snapshot.trip),
    places: structuredClone(snapshot.places),
  };
}

export const tripChangeService = createTripChangeService();
