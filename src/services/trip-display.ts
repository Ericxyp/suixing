import type {
  Trip,
  TripDay,
  TripPace,
  TripPlaceType,
  TripScheduleItem,
  TripStatus,
} from '../domain/trip/types';

export const statusLabel: Record<TripStatus, string> = { PLANNING: '规划中', READY: '已就绪', TRAVELLING: '旅行中', COMPLETED: '已完成' };
export const tripPaceLabel: Record<TripPace, string> = {
  relaxed: '轻松节奏',
  balanced: '均衡节奏',
  packed: '紧凑节奏',
};
export const tripPlaceTypeLabel: Record<TripPlaceType, string> = {
  hotel: '酒店',
  attraction: '景点',
  restaurant: '餐厅',
  cafe: '咖啡',
  transport: '交通',
  shopping: '购物',
  activity: '活动',
};
export const formatDuration = (minutes: number) => minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`;
export const formatDistance = (meters: number) => meters < 1000 ? `${meters}m` : `${(meters / 1000).toFixed(meters % 1000 ? 1 : 0)}km`;
export const formatCurrency = (amount: number) => `¥${amount.toLocaleString('zh-CN')}`;
export const formatTripDates = (trip: Trip) => trip.startDate && trip.endDate ? `${Number(trip.startDate.slice(5, 7))}月${Number(trip.startDate.slice(8))}日—${Number(trip.endDate.slice(5, 7))}月${Number(trip.endDate.slice(8))}日` : '日期待定';
export const hasItinerary = (trip: Trip) => trip.days.length > 0;

const INTERNAL_LEAK = /\$\{[^}]+\}|\$\([^)]+\)/;
const BARE_NULLISH = /^(undefined|null)$/i;
const RAW_SCHEDULE_KIND = /^(place|meal_slot|meal_place|meal|rest|area_walk|hotel_return|experience)$/;

export function isInternalDisplayLeak(value: string): boolean {
  const trimmed = value.trim();
  return INTERNAL_LEAK.test(trimmed) || BARE_NULLISH.test(trimmed) || RAW_SCHEDULE_KIND.test(trimmed);
}

export function visibleUserText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '' || isInternalDisplayLeak(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function formatCompactDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) {
    return '';
  }
  if (minutes < 60) {
    return `${minutes}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) {
    return `${hours}小时`;
  }
  if (rest === 30) {
    return `${hours}.5h`;
  }
  if (rest % 15 === 0) {
    return `${hours}h${String(rest).padStart(2, '0')}min`;
  }
  return formatDuration(minutes);
}

export function tripPreferenceTags(trip: Trip): string[] {
  const interests = trip.preferences?.interests ?? [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of interests) {
    const label = visibleUserText(item);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    tags.push(label);
    if (tags.length === 3) {
      break;
    }
  }
  return tags;
}

export function dayIsCurrentTravelDay(trip: Trip, day: TripDay, currentDate = new Date()): boolean {
  if (trip.status !== 'TRAVELLING' || !day.date) {
    return false;
  }
  const today = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  return day.date === today;
}

export function dayWorkspaceSummary(trip: Trip, day: TripDay): {
  placeCount: number;
  transitMinutes?: number;
} {
  const placeCount = day.places.length;
  const durations = trip.routes
    .filter((route) => route.dayId === day.id)
    .map((route) => route.transport.durationMinutes)
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  if (durations.length === 0) {
    return { placeCount };
  }
  return {
    placeCount,
    transitMinutes: durations.reduce((sum, minutes) => sum + minutes, 0),
  };
}

export function formatDayWorkspaceSummary(summary: { placeCount: number; transitMinutes?: number }): string {
  if (summary.placeCount < 1) {
    return '';
  }
  const places = `${summary.placeCount} 个地点`;
  if (summary.transitMinutes === undefined) {
    return places;
  }
  return `${places} · 交通约 ${formatCompactDuration(summary.transitMinutes)}`;
}

export function mealPeriodTitle(period: 'lunch' | 'dinner', kind: 'meal_slot' | 'meal_place' | 'meal'): string {
  if (kind === 'meal_slot') {
    return period === 'lunch' ? '午餐时间' : '晚餐时间';
  }
  return period === 'lunch' ? '午餐' : '晚餐';
}

export function restItemTitle(title: string | undefined): string {
  const visible = visibleUserText(title);
  if (visible) {
    return visible;
  }
  return '午间休息';
}

export function getDefaultTripDayId(trip: Trip, currentDate = new Date()): string | undefined {
  if (!trip.days.length) return undefined;
  if (trip.status !== 'TRAVELLING') return trip.days[0].id;
  const today = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  return trip.days.find((day) => day.date === today)?.id ?? trip.days[0].id;
}

export function itineraryTimelineItems(day: TripDay): TripScheduleItem[] {
  if (day.scheduleItems && day.scheduleItems.length > 0) {
    return structuredClone(day.scheduleItems) as TripScheduleItem[];
  }
  return [...day.places]
    .sort((left, right) => left.order - right.order)
    .map((place) => ({
      kind: 'place' as const,
      tripPlaceId: place.id,
      startTime: place.startTime ?? '',
      durationMinutes: place.durationMinutes ?? 0,
    }));
}

export function scheduleItemMapTripPlaceId(item: TripScheduleItem): string | undefined {
  if (item.kind === 'place' || item.kind === 'meal' || item.kind === 'meal_place') {
    return item.tripPlaceId;
  }
  return undefined;
}
