import { BffAiTripService, type RequirementExtractionService } from './bff-ai-trip-service';
import type { FetchLike } from './bff-client';
import { mockAiTripService } from './mock-ai-trip-service';

export type TripAiMode = 'mock' | 'bff';

export type { RequirementExtractionService };

export interface RequirementExtractionServiceDependencies {
  fetch?: FetchLike;
  timeoutMs?: number;
  mockService?: RequirementExtractionService;
}

export function getTripAiMode(value: string | undefined): TripAiMode {
  return value?.trim() === 'bff' ? 'bff' : 'mock';
}

export function createRequirementExtractionService(
  mode: TripAiMode,
  dependencies: RequirementExtractionServiceDependencies = {},
): RequirementExtractionService {
  if (mode === 'bff') {
    return new BffAiTripService(dependencies.fetch, dependencies.timeoutMs);
  }
  return dependencies.mockService ?? mockAiTripService;
}
