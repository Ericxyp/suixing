import type { TripChangeOperation } from './trip-change';
import type { Place, TripDiningMode, TripPace, TripPreference } from './types';

export interface TripRequirementDraft {
  destination?: string;
  origin?: string;
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  travelerCount?: number;
  totalBudget?: number;
  pace?: TripPace;
  diningMode?: TripDiningMode;
  preferences?: TripPreference;
}

export interface RequirementFieldIssue {
  field: 'destination' | 'startDate' | 'endDate' | 'durationDays' | 'travelerCount' | 'totalBudget';
  message: string;
}

export interface RequirementExtractionResult {
  draft: TripRequirementDraft;
  missingRequiredFields: RequirementFieldIssue[];
}

export interface TripPlanSuggestion {
  days: Array<{
    dayNumber: number;
    title?: string;
    summary?: string;
    suggestedPlaceQueries: string[];
  }>;
}

export interface AiTripService {
  extractRequirements(input: string): Promise<RequirementExtractionResult>;
  suggestPlan(requirements: TripRequirementDraft): Promise<TripPlanSuggestion>;
  parseChangeIntent(input: string, tripId: string): Promise<TripChangeOperation[]>;
}

/**
 * AI can suggest place names only. A PlaceProvider must resolve every name
 * into canonical POIs and coordinates before a Trip can be persisted.
 */
export interface PlaceResolutionService {
  resolveSuggestedPlaces(queries: string[], city: string): Promise<Place[]>;
}
