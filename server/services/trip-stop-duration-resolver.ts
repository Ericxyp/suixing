import type { Place, TripPace } from '../../src/domain/trip/types';
import type { TripPlanPlaceCategory } from './trip-plan-generator';
import type { ResolvedTripPlaceStop, ResolvedTripPlanSuggestion } from './trip-place-resolver';
import {
  matchStopDurationRule,
  type StopDurationBounds,
  type StopDurationRuleSource,
} from './trip-stop-duration-policy';

export const STOP_DURATION_QUANTIZE_MINUTES = 15;
export const USER_EXPLICIT_DURATION_MIN = 15;
export const USER_EXPLICIT_DURATION_MAX = 480;
export const PACE_DURATION_ADJUST_MINUTES = 15;

export type StopDurationDecisionSource = StopDurationRuleSource;
export type StopDurationDecisionReason =
  | 'USER_EXPLICIT'
  | 'RULE_DEFAULT'
  | 'AI_IN_RANGE'
  | 'AI_CLAMPED'
  | 'PACE_ADJUSTED';

export interface StopDurationDecision {
  suggestedDurationMinutes: number;
  source: StopDurationDecisionSource;
  reason: StopDurationDecisionReason;
}

export interface ResolveStopDurationInput {
  place: Place;
  suggestedDurationMinutes?: number;
  suggestionCategory?: TripPlanPlaceCategory;
  pace?: TripPace;
  destination?: string;
  userExplicitDurationMinutes?: number;
  idRules?: Readonly<Record<string, StopDurationBounds>>;
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

function cloneStop(stop: ResolvedTripPlaceStop): ResolvedTripPlaceStop {
  const cloned: ResolvedTripPlaceStop = {
    place: clonePlace(stop.place),
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

function quantizeToStep(value: number, min: number, max: number, step = STOP_DURATION_QUANTIZE_MINUTES): number {
  const rounded = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, rounded));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveStopDuration(input: ResolveStopDurationInput): StopDurationDecision {
  if (isPositiveInteger(input.userExplicitDurationMinutes)) {
    return {
      suggestedDurationMinutes: quantizeToStep(
        input.userExplicitDurationMinutes,
        USER_EXPLICIT_DURATION_MIN,
        USER_EXPLICIT_DURATION_MAX,
      ),
      source: 'USER_EXPLICIT',
      reason: 'USER_EXPLICIT',
    };
  }

  const rule = matchStopDurationRule({
    place: input.place,
    destination: input.destination,
    suggestionCategory: input.suggestionCategory,
    pace: input.pace,
    idRules: input.idRules,
  });

  let minutes = rule.defaultMinutes;
  let reason: StopDurationDecisionReason = 'RULE_DEFAULT';
  const ai = input.suggestedDurationMinutes;
  if (rule.source === 'UNKNOWN_DEFAULT' && isPositiveInteger(ai)) {
    if (ai >= rule.minMinutes && ai <= rule.maxMinutes) {
      minutes = ai;
      reason = 'AI_IN_RANGE';
    } else {
      minutes = clamp(ai, rule.minMinutes, rule.maxMinutes);
      reason = 'AI_CLAMPED';
    }
  }

  if (input.pace === 'relaxed') {
    const next = Math.min(rule.maxMinutes, minutes + PACE_DURATION_ADJUST_MINUTES);
    if (next !== minutes) {
      minutes = next;
      reason = 'PACE_ADJUSTED';
    }
  } else if (input.pace === 'packed') {
    const next = Math.max(rule.minMinutes, minutes - PACE_DURATION_ADJUST_MINUTES);
    if (next !== minutes) {
      minutes = next;
      reason = 'PACE_ADJUSTED';
    }
  }

  return {
    suggestedDurationMinutes: quantizeToStep(minutes, rule.minMinutes, rule.maxMinutes),
    source: rule.source,
    reason,
  };
}

export function applyResolvedTripStopDurations(
  plan: ResolvedTripPlanSuggestion,
  input: {
    destination: string;
    pace?: TripPace;
    idRules?: Readonly<Record<string, StopDurationBounds>>;
  },
): ResolvedTripPlanSuggestion {
  return {
    title: plan.title,
    summary: plan.summary,
    unresolved: plan.unresolved.map((item) => ({
      dayNumber: item.dayNumber,
      name: item.name,
      query: item.query,
      reason: item.reason,
    })),
    days: plan.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: day.stops.map((stop) => {
        const cloned = cloneStop(stop);
        const decision = resolveStopDuration({
          place: cloned.place,
          suggestedDurationMinutes: cloned.suggestedDurationMinutes,
          suggestionCategory: cloned.category,
          pace: input.pace,
          destination: input.destination,
          idRules: input.idRules,
        });
        cloned.suggestedDurationMinutes = decision.suggestedDurationMinutes;
        return cloned;
      }),
    })),
  };
}
