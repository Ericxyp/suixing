import type { Place, TripPlaceType, TripScheduleItem } from '../domain/trip/types';
import { formatCompactDuration, formatDuration, tripPlaceTypeLabel, visibleUserText } from './trip-display';

export const MEAL_APPLY_FAILED_NOTICE = '暂时无法加入这家餐厅，请稍后重试。';
export const MEAL_OPTIONS_EMPTY_TITLE = '暂时没找到合适的餐饮选择';
export const MEAL_OPTIONS_EMPTY_COPY = '你可以保留这段用餐时间，或稍后再试。';

export function mealOptionsHeading(
  slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>,
  areaName: string,
): string {
  const period = slot.mealPeriod === 'lunch' ? '午餐' : '晚餐';
  const area = visibleUserText(areaName) ?? '当前区域';
  return `${period} · ${area}`;
}

export function mealOptionsContext(
  slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>,
  areaName: string,
  nextName?: string,
): string {
  const reserved = formatCompactDuration(slot.durationMinutes) || formatDuration(slot.durationMinutes);
  const area = visibleUserText(areaName) ?? '当前区域';
  const next = visibleUserText(nextName);
  if (next) {
    return `预留 ${reserved} · 位于${area}与${next}之间`;
  }
  return `预留 ${reserved}`;
}

export function mealOptionTypeLabel(category: TripPlaceType): string {
  if (category === 'cafe') {
    return '咖啡休息';
  }
  if (category === 'restaurant') {
    return '餐厅';
  }
  return tripPlaceTypeLabel[category];
}

export function mealOptionRouteCopy(_place: Place, nextName?: string): string {
  const next = visibleUserText(nextName);
  if (next) {
    return `顺路前往${next}`;
  }
  return '靠近当前区域';
}
