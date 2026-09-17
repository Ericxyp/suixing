import type { Trip, TripDay, TripScheduleItem, TripStatus } from '../domain/trip/types';

export const statusLabel: Record<TripStatus, string> = { PLANNING: '规划中', READY: '已就绪', TRAVELLING: '旅行中', COMPLETED: '已完成' };
export const formatDuration = (minutes: number) => minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`;
export const formatDistance = (meters: number) => meters < 1000 ? `${meters}m` : `${(meters / 1000).toFixed(meters % 1000 ? 1 : 0)}km`;
export const formatCurrency = (amount: number) => `¥${amount.toLocaleString('zh-CN')}`;
export const formatTripDates = (trip: Trip) => trip.startDate && trip.endDate ? `${Number(trip.startDate.slice(5, 7))}月${Number(trip.startDate.slice(8))}日—${Number(trip.endDate.slice(5, 7))}月${Number(trip.endDate.slice(8))}日` : '日期待定';
export const hasItinerary = (trip: Trip) => trip.days.length > 0;
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
