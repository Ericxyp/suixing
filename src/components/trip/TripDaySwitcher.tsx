import { useEffect, useRef } from 'react';
import type { Trip, TripDay } from '../../domain/trip/types';
import { visibleUserText } from '../../services/trip-display';

export function TripDaySwitcher({
  trip,
  day,
  onSelect,
}: {
  trip: Trip;
  day: TripDay;
  onSelect: (dayId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [day.id]);

  return (
    <div className="day-switcher" role="tablist" aria-label="行程日期" ref={listRef}>
      {trip.days.map((item) => (
        <button
          role="tab"
          aria-selected={item.id === day.id}
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
        >
          <span>Day {item.dayNumber}</span>
          <small>{visibleUserText(item.title) ?? (item.date || `第${item.dayNumber}天`)}</small>
        </button>
      ))}
    </div>
  );
}
