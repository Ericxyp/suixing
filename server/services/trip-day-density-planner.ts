import type {
  Place,
  TripDiningMode,
  TripPace,
  TripPlace,
  TripScheduleItem,
} from '../../src/domain/trip/types';
import { GENERIC_PLACEHOLDER_PATTERN } from './trip-itinerary-completeness-validator';
import { TRANSFER_BUFFER_MINUTES } from './trip-time-scheduler';

export const MAX_DAY_SCHEDULE_ITEMS = 12;
export const EXPERIENCE_MIN_MINUTES = 45;
export const REST_MAX_MINUTES = 45;
export const MAX_CLOCK_MINUTES = 23 * 60 + 59;
export const LONG_STAY_MINUTES = 180;
export const DEFAULT_LUNCH_MINUTES = 75;
export const MIN_LUNCH_MINUTES = 60;

export type DensityPlanReason =
  | 'PLACE'
  | 'MEAL'
  | 'MEAL_SLOT'
  | 'REST'
  | 'AREA_WALK'
  | 'HOTEL_RETURN'
  | 'SKIPPED_PACKED';

export interface PlanDayScheduleInput {
  dayId: string;
  destination: string;
  pace?: TripPace;
  diningMode?: TripDiningMode;
  places: readonly TripPlace[];
  dayNumber?: number;
  dayTitle?: string;
  catalog?: readonly Place[];
}

export interface PlanDayScheduleResult {
  items: TripScheduleItem[];
  reasons: DensityPlanReason[];
  places: TripPlace[];
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AREA_NAME = /街|巷|胡同|湖|海|园|公园|景区/;

export function resolveDiningMode(mode?: TripDiningMode): TripDiningMode {
  if (mode === 'arranged' || mode === 'self_managed') {
    return mode;
  }
  return 'flexible';
}

export function resolveTripPace(pace?: TripPace): TripPace {
  if (pace === 'relaxed' || pace === 'packed') {
    return pace;
  }
  return 'balanced';
}

export function parseClockMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CLOCK.test(value)) {
    return undefined;
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function formatClockMinutes(totalMinutes: number): string | undefined {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0 || totalMinutes > MAX_CLOCK_MINUTES) {
    return undefined;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function isLongStayTripPlace(place: TripPlace): boolean {
  return (place.durationMinutes ?? 0) >= LONG_STAY_MINUTES;
}

export function isMealTripPlace(place: TripPlace): boolean {
  return place.type === 'restaurant' || place.type === 'cafe';
}

export function isCoreTripPlace(place: TripPlace): boolean {
  return !isMealTripPlace(place) && place.type !== 'transport' && place.type !== 'hotel';
}

export function isVisitTripPlace(place: TripPlace): boolean {
  return place.type !== 'transport' && place.type !== 'hotel';
}

function mealPeriodForStart(start: number): 'lunch' | 'dinner' | undefined {
  if (start >= 11 * 60 && start < 16 * 60 + 30) {
    return 'lunch';
  }
  if (start >= 16 * 60 + 30 && start <= 21 * 60) {
    return 'dinner';
  }
  return undefined;
}

function ceilToStep(minutes: number): number {
  return Math.ceil(minutes / 5) * 5;
}

function clonePlace(place: TripPlace): TripPlace {
  return structuredClone(place) as TripPlace;
}

type DraftItem = TripScheduleItem & { placeRef?: TripPlace };

function transitAfter(place: TripPlace | undefined): number {
  const duration = place?.transportToNext?.durationMinutes;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
    return duration;
  }
  return 0;
}

export function cloneTripScheduleItems(
  items: readonly TripScheduleItem[] | undefined,
): TripScheduleItem[] | undefined {
  if (!items) {
    return undefined;
  }
  return structuredClone(items) as TripScheduleItem[];
}

export function planDaySchedule(input: PlanDayScheduleInput): PlanDayScheduleResult {
  void input.destination;
  const places = [...input.places]
    .filter((place) => (place.durationMinutes ?? 0) >= 1)
    .sort((left, right) => (
      (parseClockMinutes(left.startTime) ?? left.order) - (parseClockMinutes(right.startTime) ?? right.order)
    ))
    .map((place) => clonePlace(place));
  const reasons: DensityPlanReason[] = [];
  const pace = resolveTripPace(input.pace);
  const diningMode = resolveDiningMode(input.diningMode);
  const drafts: DraftItem[] = [];

  for (const place of places) {
    const durationMinutes = place.durationMinutes ?? 90;
    const start = parseClockMinutes(place.startTime) ?? 10 * 60;
    if (isMealTripPlace(place)) {
      const alreadyLunch = drafts.some((item) => (
        (item.kind === 'meal' || item.kind === 'meal_place') && item.mealPeriod === 'lunch'
      ));
      const mealPeriod = alreadyLunch ? 'dinner' : mealPeriodForStart(start) ?? 'lunch';
      drafts.push({
        kind: 'meal_place',
        tripPlaceId: place.id,
        startTime: place.startTime ?? '12:00',
        durationMinutes,
        mealPeriod,
        placeRef: place,
      });
      reasons.push('MEAL');
      continue;
    }
    drafts.push({
      kind: 'place',
      tripPlaceId: place.id,
      startTime: place.startTime ?? '10:00',
      durationMinutes,
      placeRef: place,
    });
    reasons.push('PLACE');
  }

  const hasLunch = drafts.some((item) => (
    (item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot')
    && item.mealPeriod === 'lunch'
  ));
  const firstCore = places.find((place) => isCoreTripPlace(place));
  const cores = places.filter((place) => isCoreTripPlace(place));
  const firstCoreDraftIndex = drafts.findIndex((item) => (
    item.kind === 'place' && item.tripPlaceId === firstCore?.id
  ));
  if (!hasLunch && firstCore && firstCoreDraftIndex >= 0 && diningMode !== 'arranged') {
    const nextCore = cores.find((place) => place.id !== firstCore.id);
    drafts.splice(firstCoreDraftIndex + 1, 0, {
      kind: 'meal_slot',
      id: `${input.dayId}:meal:lunch`,
      mealPeriod: 'lunch',
      startTime: '11:30',
      durationMinutes: DEFAULT_LUNCH_MINUTES,
      areaTripPlaceId: firstCore.id,
      diningMode,
      ...(nextCore ? { nextTripPlaceId: nextCore.id } : {}),
    });
    reasons.push('MEAL_SLOT');
  } else if (
    !hasLunch
    && diningMode !== 'arranged'
    && !places.some((place) => isMealTripPlace(place))
    && firstCore
    && firstCoreDraftIndex >= 0
  ) {
    drafts.splice(firstCoreDraftIndex + 1, 0, {
      kind: 'rest',
      id: `${input.dayId}:rest:1`,
      startTime: '11:30',
      durationMinutes: REST_MAX_MINUTES,
      title: isLongStayTripPlace(firstCore) ? '参观后休息' : '午间休息',
      description: isLongStayTripPlace(firstCore)
        ? '参观后稍作休息，再继续下一项安排。'
        : '午间稍作休息，再继续下一项安排。',
    });
    reasons.push('REST');
  }

  const stillHasLunchMeal = drafts.some((item) => (
    (item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot')
    && item.mealPeriod === 'lunch'
  ));
  if (stillHasLunchMeal) {
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      if (drafts[index].kind === 'rest') {
        drafts.splice(index, 1);
      }
    }
  }

  let cursor = parseClockMinutes(places[0]?.startTime) ?? 10 * 60;
  if (cursor < 10 * 60 || cursor > 11 * 60 + 30) {
    cursor = 10 * 60;
  }
  for (let index = 0; index < drafts.length; index += 1) {
    const item = drafts[index];
    const startTime = formatClockMinutes(cursor);
    if (!startTime) {
      break;
    }
    item.startTime = startTime;
    if (item.placeRef) {
      item.placeRef.startTime = startTime;
    }
    const end = cursor + item.durationMinutes;
    const next = drafts[index + 1];
    if (!next) {
      cursor = end;
      break;
    }
    const lastPlace = [...drafts.slice(0, index + 1)].reverse().find((entry) => entry.kind === 'place');
    const transit = next.kind === 'place' && lastPlace?.placeRef
      ? transitAfter(lastPlace.placeRef)
      : 0;
    cursor = ceilToStep(end + transit + TRANSFER_BUFFER_MINUTES);
  }

  const hasDinner = drafts.some((item) => (
    (item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot')
    && item.mealPeriod === 'dinner'
  ));
  const lastCore = [...cores].reverse()[0];
  const lastCoreItem = drafts.find((item) => item.kind === 'place' && item.tripPlaceId === lastCore?.id);
  const lastCoreEnd = lastCoreItem
    ? (parseClockMinutes(lastCoreItem.startTime) ?? 0) + lastCoreItem.durationMinutes
    : 0;
  if (
    !hasDinner
    && diningMode !== 'arranged'
    && lastCore
    && lastCoreEnd >= 17 * 60 + 30
    && lastCoreEnd + 75 <= MAX_CLOCK_MINUTES
  ) {
    const startTime = formatClockMinutes(lastCoreEnd + TRANSFER_BUFFER_MINUTES);
    if (startTime) {
      drafts.push({
        kind: 'meal_slot',
        id: `${input.dayId}:meal:dinner`,
        mealPeriod: 'dinner',
        startTime,
        durationMinutes: 75,
        areaTripPlaceId: lastCore.id,
        diningMode,
      });
      reasons.push('MEAL_SLOT');
    }
  }

  const lastEnd = drafts.reduce((max, item) => (
    Math.max(max, (parseClockMinutes(item.startTime) ?? 0) + item.durationMinutes)
  ), 0);
  if (!hasDinner && lastEnd < 17 * 60) {
    const area = cores.find((place) => AREA_NAME.test(place.placeName));
    const options = cores.filter((place) => place.id !== area?.id).slice(0, 3);
    if (area && options.length >= 2) {
      const start = ceilToStep(Math.max(lastEnd + TRANSFER_BUFFER_MINUTES, 14 * 60));
      const startTime = formatClockMinutes(start);
      const names = options.map((place) => place.placeName);
      const title = `${area.placeName.replace(/风景区$/, '')}周边慢逛`;
      const description = `以${area.placeName}为主线，可按时间选择前往${names[0]}或${names[1]}。`;
      if (
        startTime
        && start < 20 * 60 + 30
        && !GENERIC_PLACEHOLDER_PATTERN.test(title)
        && !GENERIC_PLACEHOLDER_PATTERN.test(description)
      ) {
        drafts.push({
          kind: 'area_walk',
          id: `${input.dayId}:walk:1`,
          startTime,
          durationMinutes: 60,
          areaTripPlaceId: area.id,
          optionTripPlaceIds: options.slice(0, 3).map((place) => place.id),
          title,
          description,
        });
        reasons.push('AREA_WALK');
      }
    }
  }

  const stillNeedsEvening = !drafts.some((item) => (
    ((item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot') && item.mealPeriod === 'dinner')
    || item.kind === 'area_walk'
    || item.kind === 'hotel_return'
  ));
  const afterWalkEnd = drafts.reduce((max, item) => (
    Math.max(max, (parseClockMinutes(item.startTime) ?? 0) + item.durationMinutes)
  ), 0);
  if (stillNeedsEvening && afterWalkEnd < 17 * 60 && pace !== 'packed') {
    const start = ceilToStep(Math.max(
      afterWalkEnd + TRANSFER_BUFFER_MINUTES,
      pace === 'relaxed' ? 16 * 60 : 16 * 60 + 15,
    ));
    const startTime = formatClockMinutes(start);
    if (startTime && start <= 20 * 60 + 30 && start - afterWalkEnd <= 90) {
      drafts.push({
        kind: 'hotel_return',
        id: `${input.dayId}:return:1`,
        startTime,
        durationMinutes: 45,
        title: '返程准备',
        description: '结束当天行程，预留返回住处的时间。',
      });
      reasons.push('HOTEL_RETURN');
    }
  } else if (pace === 'packed') {
    reasons.push('SKIPPED_PACKED');
  }

  const items: TripScheduleItem[] = drafts.slice(0, MAX_DAY_SCHEDULE_ITEMS).map((item) => {
    const next = { ...item };
    delete next.placeRef;
    return next as TripScheduleItem;
  });
  return { items, reasons, places };
}

export function planDayScheduleItems(input: PlanDayScheduleInput): TripScheduleItem[] {
  return planDaySchedule(input).items;
}
