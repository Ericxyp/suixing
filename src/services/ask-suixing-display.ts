import type { Trip, TripDay } from '../domain/trip/types';
import {
  dayWorkspaceSummary,
  formatDayWorkspaceSummary,
  visibleUserText,
} from './trip-display';

export const ASK_SUIXING_HINT = '直接说想替换、调整或取消哪个地点。';
export const ASK_SUIXING_CAPABILITY = '例如：把今天下午的博物馆换成公园';

export function askSuixingDayLabel(day: TripDay): string {
  const title = visibleUserText(day.title) ?? '当天行程';
  return `Day ${day.dayNumber} · ${title}`;
}

export function askSuixingDaySummary(trip: Trip, day: TripDay): string {
  return formatDayWorkspaceSummary(dayWorkspaceSummary(trip, day));
}

function firstNamedPlace(day: TripDay): string | undefined {
  const ranked = [...day.places].sort((left, right) => left.order - right.order);
  const preferred = ranked.filter((place) => place.type !== 'hotel' && place.type !== 'transport');
  for (const place of preferred.length > 0 ? preferred : ranked) {
    const name = visibleUserText(place.placeName);
    if (name) {
      return name;
    }
  }
  return undefined;
}

export function askSuixingPlaceholder(day: TripDay): string {
  const place = firstNamedPlace(day);
  if (place) {
    return `例如：把${place}换成附近博物馆`;
  }
  const title = visibleUserText(day.title);
  if (title) {
    return `例如：把${title}的地点换成附近公园`;
  }
  return ASK_SUIXING_CAPABILITY;
}

export function askSuixingExamples(day: TripDay): string[] {
  const place = firstNamedPlace(day);
  const examples = [
    '把下午的地点换成附近博物馆',
    '换成一家咖啡馆',
  ];
  if (place) {
    examples.push(`今天不要去${place}，换成附近博物馆`);
  } else {
    examples.push('把今天的地点换成附近公园');
  }
  return examples.slice(0, 3);
}
