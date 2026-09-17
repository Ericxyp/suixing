import type { CreateTripInput, TripRepository } from '../repositories/trip-repository';
import { BffClientError, type FetchLike } from './bff-client';
import {
  BffTripGenerationService,
  DEFAULT_TRIP_GENERATION_TIMEOUT_MS,
  type TripGenerationResult,
} from './bff-trip-generation-service';

export type TripGenerationMode = 'mock' | 'bff';

export interface TripGenerationService {
  generate(requirements: CreateTripInput['requirements']): Promise<TripGenerationResult>;
}

export interface TripGenerationServiceDependencies {
  userId: string;
  repository: TripRepository;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export const TRIP_GENERATION_INCOMPLETE_NOTICE = '暂时无法补全这一天的可执行安排，请稍后重试或补充偏好。';
export const TRIP_GENERATION_TIMEOUT_NOTICE = '行程生成时间较长，请稍后重试。';
export const TRIP_GENERATION_INVALID_RESPONSE_NOTICE = '服务返回结果异常，请稍后重试。';
export const TRIP_GENERATION_PROVIDER_ERROR_NOTICE = '地点与路线服务暂时不可用，请稍后重试。';
export const TRIP_GENERATION_PROVIDER_UNAVAILABLE_NOTICE = '地点与路线服务尚未配置，请稍后再试。';
export const TRIP_GENERATION_AI_UNAVAILABLE_NOTICE = '智能服务尚未配置，请稍后再试。';
export const TRIP_GENERATION_GENERIC_NOTICE = '暂时无法生成旅行方案，请稍后重试。';

export function getTripGenerationMode(value: string | undefined): TripGenerationMode {
  return value?.trim() === 'bff' ? 'bff' : 'mock';
}

export function noticeForTripGenerationError(error: unknown): string {
  if (error instanceof BffClientError) {
    if (error.code === 'TRIP_GENERATION_INCOMPLETE') {
      return TRIP_GENERATION_INCOMPLETE_NOTICE;
    }
    if (error.code === 'TRIP_GENERATION_TIMEOUT') {
      return TRIP_GENERATION_TIMEOUT_NOTICE;
    }
    if (error.code === 'INVALID_RESPONSE' || error.code === 'AI_INVALID_RESPONSE') {
      return TRIP_GENERATION_INVALID_RESPONSE_NOTICE;
    }
    if (error.code === 'PROVIDER_ERROR') {
      return TRIP_GENERATION_PROVIDER_ERROR_NOTICE;
    }
    if (error.code === 'PROVIDER_UNAVAILABLE') {
      return TRIP_GENERATION_PROVIDER_UNAVAILABLE_NOTICE;
    }
    if (error.code === 'AI_PROVIDER_UNAVAILABLE') {
      return TRIP_GENERATION_AI_UNAVAILABLE_NOTICE;
    }
  }
  return TRIP_GENERATION_GENERIC_NOTICE;
}

class MockTripGenerationService implements TripGenerationService {
  constructor(
    private readonly userId: string,
    private readonly repository: TripRepository,
  ) {}

  async generate(
    requirements: CreateTripInput['requirements'],
  ): Promise<TripGenerationResult> {
    const trip = await this.repository.createTrip({
      userId: this.userId,
      requirements,
    });
    return {
      trip,
      places: [],
      diagnostics: {
        unresolvedPlacesCount: 0,
        unresolvedRoutesCount: 0,
      },
    };
  }
}

export function createTripGenerationService(
  mode: TripGenerationMode,
  dependencies: TripGenerationServiceDependencies,
): TripGenerationService {
  if (mode === 'bff') {
    return new BffTripGenerationService(
      dependencies.fetch,
      dependencies.timeoutMs ?? DEFAULT_TRIP_GENERATION_TIMEOUT_MS,
    );
  }
  return new MockTripGenerationService(dependencies.userId, dependencies.repository);
}
