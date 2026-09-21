import type { TripPace, TripPlace, TripScheduleItem } from '../../src/domain/trip/types';

export const GENERIC_PLACEHOLDER_PATTERN = /自由活动|自由探索|附近逛逛|随意走走|随便逛|按自己的节奏|不安排固定地点|午后自由探索|傍晚自由探索|城市漫步/;

export type ItineraryCompletenessReason =
  | 'GENERIC_PLACEHOLDER'
  | 'MISSING_LUNCH'
  | 'MISSING_DINNER'
  | 'UNEXPLAINED_GAP'
  | 'INVALID_AREA_WALK'
  | 'INVALID_SCHEDULE_REFERENCE'
  | 'DAY_ENDS_TOO_EARLY'
  | 'MISSING_CORE_PLACES'
  | 'INSUFFICIENT_CORE_PLACES'
  | 'INVALID_TWO_PLACE_DAY'
  | 'SCHEDULE_OVERLAP'
  | 'MEAL_REST_CONFLICT';

export interface ItineraryCompletenessInput {
  pace?: TripPace;
  targetCorePlacesPerDay?: 2 | 3;
  placeIds: ReadonlySet<string>;
  corePlaceCount: number;
  items: readonly TripScheduleItem[];
  places?: readonly TripPlace[];
  allowUserFreeTime?: boolean;
}

export interface ItineraryCompletenessResult {
  valid: boolean;
  reason?: ItineraryCompletenessReason;
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_GAP = 90;
const MAX_CLOCK = 23 * 60 + 59;
const SIX_HOURS = 6 * 60;
const LONG_STAY_MINUTES = 180;

function resolveTripPace(pace?: TripPace): TripPace {
  return pace === 'relaxed' || pace === 'packed' ? pace : 'balanced';
}

function isCorePlaceType(type: TripPlace['type']): boolean {
  return type !== 'restaurant' && type !== 'cafe' && type !== 'transport' && type !== 'hotel';
}

function parseClock(value: string): number | undefined {
  if (!CLOCK.test(value)) {
    return undefined;
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function itemEnd(item: TripScheduleItem): number | undefined {
  const start = parseClock(item.startTime);
  return start === undefined ? undefined : start + item.durationMinutes;
}

function covers(item: TripScheduleItem, windowStart: number, windowEnd: number): boolean {
  const start = parseClock(item.startTime);
  if (start === undefined) {
    return false;
  }
  return start < windowEnd && start + item.durationMinutes > windowStart;
}

function isGeneric(item: TripScheduleItem): boolean {
  if (item.kind === 'experience') {
    return true;
  }
  if (item.kind === 'rest' || item.kind === 'area_walk' || item.kind === 'hotel_return') {
    return GENERIC_PLACEHOLDER_PATTERN.test(`${item.title}${item.description}`);
  }
  return false;
}

function experienceMinutes(items: readonly TripScheduleItem[]): number {
  if (items.length === 0) {
    return 0;
  }
  let total = 0;
  for (const item of items) {
    total += item.durationMinutes;
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    const end = itemEnd(items[index]);
    const nextStart = parseClock(items[index + 1].startTime);
    if (end === undefined || nextStart === undefined || nextStart <= end) {
      continue;
    }
    total += nextStart - end;
  }
  return total;
}

export function isValidTwoCorePlaceDowngrade(input: {
  pace?: TripPace;
  corePlaceCount: number;
  items: readonly TripScheduleItem[];
  places?: readonly TripPlace[];
}): boolean {
  const pace = resolveTripPace(input.pace);
  if (pace === 'packed' || input.corePlaceCount !== 2) {
    return false;
  }
  const items = [...input.items].sort((left, right) => (
    (parseClock(left.startTime) ?? 0) - (parseClock(right.startTime) ?? 0)
  ));
  const last = items[items.length - 1];
  const lastEnd = last ? itemEnd(last) : undefined;
  if (lastEnd === undefined || lastEnd < 17 * 60) {
    return false;
  }
  const longStay = (input.places ?? []).some((place) => (
    isCorePlaceType(place.type) && (place.durationMinutes ?? 0) >= LONG_STAY_MINUTES
  )) || items.some((item) => (
    item.kind === 'place' && item.durationMinutes >= LONG_STAY_MINUTES
  ));
  if (!longStay) {
    return false;
  }
  if (experienceMinutes(items) < SIX_HOURS) {
    return false;
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    const end = itemEnd(items[index]);
    const nextStart = parseClock(items[index + 1].startTime);
    if (end === undefined || nextStart === undefined || nextStart - end > MAX_GAP) {
      return false;
    }
  }
  return true;
}

export function targetCorePlaceCount(pace?: TripPace, targetCorePlacesPerDay?: 2 | 3): number {
  if (resolveTripPace(pace) === 'packed') {
    return 3;
  }
  if (targetCorePlacesPerDay === 2 || targetCorePlacesPerDay === 3) {
    return targetCorePlacesPerDay;
  }
  return resolveTripPace(pace) === 'relaxed' ? 2 : 3;
}

function sortedItems(items: readonly TripScheduleItem[]): TripScheduleItem[] {
  return [...items].sort((left, right) => (
    (parseClock(left.startTime) ?? 0) - (parseClock(right.startTime) ?? 0)
  ));
}

function hasLunchCoverage(items: readonly TripScheduleItem[]): boolean {
  const lunchMeals = items.filter((item) => isMealArrangement(item, 'lunch'));
  const lunchRests = items.filter((item) => (
    item.kind === 'rest' && covers(item, 11 * 60 + 30, 14 * 60)
  ));
  return lunchMeals.length > 0 || lunchRests.length > 0
    || items.some((item) => item.kind === 'meal' && covers(item, 11 * 60, 16 * 60 + 30));
}

function hasScheduleDefect(items: readonly TripScheduleItem[]): boolean {
  for (let index = 0; index < items.length - 1; index += 1) {
    const end = itemEnd(items[index]);
    const nextStart = parseClock(items[index + 1].startTime);
    if (end === undefined || nextStart === undefined) {
      return true;
    }
    if (nextStart < end || items[index].startTime === items[index + 1].startTime) {
      return true;
    }
    if (nextStart - end > MAX_GAP) {
      return true;
    }
  }
  return items.some((item) => item.kind === 'rest' && item.durationMinutes > 45);
}

export function isValidPolicyTwoCoreDay(input: ItineraryCompletenessInput): boolean {
  if (input.targetCorePlacesPerDay !== 2 || resolveTripPace(input.pace) === 'packed') {
    return false;
  }
  if (input.corePlaceCount !== 2) {
    return false;
  }
  const items = sortedItems(input.items);
  if (items.length === 0 || items.some((item) => isGeneric(item) && input.allowUserFreeTime !== true)) {
    return false;
  }
  if (!hasLunchCoverage(items) || hasScheduleDefect(items)) {
    return false;
  }
  const lastEnd = items.length ? itemEnd(items[items.length - 1]) : undefined;
  return lastEnd !== undefined && lastEnd >= 16 * 60 + 30;
}

function isMealArrangement(
  item: TripScheduleItem,
  period: 'lunch' | 'dinner',
): boolean {
  return (item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot')
    && item.mealPeriod === period;
}

export function validateDayItineraryCompleteness(
  input: ItineraryCompletenessInput,
): ItineraryCompletenessResult {
  const pace = resolveTripPace(input.pace);
  const items = sortedItems(input.items);
  if (input.corePlaceCount < 2) {
    return { valid: false, reason: 'MISSING_CORE_PLACES' };
  }
  const lunchMeals = items.filter((item) => isMealArrangement(item, 'lunch'));
  const lunchRests = items.filter((item) => (
    item.kind === 'rest' && covers(item, 11 * 60 + 30, 14 * 60)
  ));
  if (lunchMeals.length > 0 && lunchRests.length > 0) {
    return { valid: false, reason: 'MEAL_REST_CONFLICT' };
  }
  for (const item of items) {
    if (isGeneric(item) && input.allowUserFreeTime !== true) {
      return { valid: false, reason: 'GENERIC_PLACEHOLDER' };
    }
    if (item.kind === 'place' && !input.placeIds.has(item.tripPlaceId)) {
      return { valid: false, reason: 'INVALID_SCHEDULE_REFERENCE' };
    }
    if (item.kind === 'meal' || item.kind === 'meal_place') {
      if (!input.placeIds.has(item.tripPlaceId)) {
        return { valid: false, reason: 'INVALID_SCHEDULE_REFERENCE' };
      }
    }
    if (item.kind === 'meal_slot') {
      if (
        !input.placeIds.has(item.areaTripPlaceId)
        || (item.nextTripPlaceId && !input.placeIds.has(item.nextTripPlaceId))
        || item.durationMinutes < 60
        || item.durationMinutes > 90
      ) {
        return { valid: false, reason: 'INVALID_SCHEDULE_REFERENCE' };
      }
    }
    if (item.kind === 'area_walk') {
      if (
        !input.placeIds.has(item.areaTripPlaceId)
        || item.optionTripPlaceIds.length < 2
        || item.optionTripPlaceIds.length > 3
        || item.optionTripPlaceIds.some((id) => !input.placeIds.has(id))
        || GENERIC_PLACEHOLDER_PATTERN.test(`${item.title}${item.description}`)
      ) {
        return { valid: false, reason: 'INVALID_AREA_WALK' };
      }
    }
    if (item.kind === 'rest' && item.durationMinutes > 45) {
      return { valid: false, reason: 'UNEXPLAINED_GAP' };
    }
  }
  if (!hasLunchCoverage(items)) {
    return { valid: false, reason: 'MISSING_LUNCH' };
  }
  const last = items[items.length - 1];
  const lastEnd = last ? itemEnd(last) : undefined;
  const policyAllowsTwoCores = input.targetCorePlacesPerDay === 2 && pace !== 'packed';
  const minEnd = pace === 'relaxed' || policyAllowsTwoCores ? 16 * 60 + 30 : 17 * 60;
  if (lastEnd === undefined || lastEnd < 11 * 60) {
    return { valid: false, reason: 'DAY_ENDS_TOO_EARLY' };
  }
  if (lastEnd < minEnd && !(pace === 'balanced' && isValidTwoCorePlaceDowngrade(input))) {
    if (pace !== 'packed') {
      return { valid: false, reason: 'DAY_ENDS_TOO_EARLY' };
    }
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    const end = itemEnd(items[index]);
    const nextStart = parseClock(items[index + 1].startTime);
    if (end === undefined || nextStart === undefined) {
      return { valid: false, reason: 'INVALID_SCHEDULE_REFERENCE' };
    }
    if (nextStart < end || items[index].startTime === items[index + 1].startTime) {
      return { valid: false, reason: 'SCHEDULE_OVERLAP' };
    }
    if (nextStart - end > MAX_GAP) {
      return { valid: false, reason: 'UNEXPLAINED_GAP' };
    }
  }
  if (lastEnd > MAX_CLOCK) {
    return { valid: false, reason: 'UNEXPLAINED_GAP' };
  }
  const hasDinner = items.some((item) => (
    isMealArrangement(item, 'dinner')
    || item.kind === 'area_walk'
    || item.kind === 'hotel_return'
    || (item.kind === 'place' && (parseClock(item.startTime) ?? 0) >= 17 * 60)
  ));
  if (lastEnd >= 17 * 60 + 30 && !hasDinner) {
    return { valid: false, reason: 'MISSING_DINNER' };
  }
  const requiredCores = targetCorePlaceCount(input.pace, input.targetCorePlacesPerDay);
  if (pace === 'packed' && input.corePlaceCount < 3) {
    return { valid: false, reason: 'INSUFFICIENT_CORE_PLACES' };
  }
  if (requiredCores > 2 && input.corePlaceCount < requiredCores) {
    if (pace === 'balanced' && isValidTwoCorePlaceDowngrade(input)) {
      return { valid: true };
    }
    if (isValidPolicyTwoCoreDay(input)) {
      return { valid: true };
    }
    return {
      valid: false,
      reason: input.corePlaceCount === 2 ? 'INVALID_TWO_PLACE_DAY' : 'INSUFFICIENT_CORE_PLACES',
    };
  }
  return { valid: true };
}
