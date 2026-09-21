import type { Trip, TripDay, TripScheduleItem } from '../../domain/trip/types';
import {
  dayIsCurrentTravelDay,
  dayWorkspaceSummary,
  formatCompactDuration,
  formatDayWorkspaceSummary,
  formatDistance,
  formatDuration,
  itineraryTimelineItems,
  mealPeriodTitle,
  restItemTitle,
  scheduleItemMapTripPlaceId,
  tripPlaceTypeLabel,
  visibleUserText,
} from '../../services/trip-display';

const transportLabels = { walk: '步行', metro: '地铁', taxi: '打车', bus: '公交', drive: '驾车' };
const GENERIC_FREE = /自由活动|自由探索|随便逛|自由逛街/;

function scheduleHeading(kind: 'rest' | 'hotel_return' | 'experience', title?: string): string {
  const visible = visibleUserText(title);
  if (visible && !GENERIC_FREE.test(visible)) {
    return kind === 'rest' ? restItemTitle(visible) : visible;
  }
  if (kind === 'rest') {
    return restItemTitle(title);
  }
  if (kind === 'hotel_return') {
    return '返程准备';
  }
  return '行程安排';
}

export function ItineraryTimeline({
  trip,
  day,
  selectedTripPlaceId,
  mapNotice,
  onPlaceSelect,
  onOpenMeal,
}: {
  trip: Trip;
  day: TripDay;
  selectedTripPlaceId?: string | null;
  mapNotice?: string | null;
  onPlaceSelect?: (tripPlaceId: string) => void;
  onOpenMeal?: (
    slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>,
    trigger?: HTMLButtonElement | null,
  ) => void;
}) {
  if (!day.places.length) {
    return <p className="state-message">这一天的行程还在准备中。</p>;
  }
  const items = itineraryTimelineItems(day);
  const placeById = new Map(day.places.map((place) => [place.id, place]));
  const firstPlaceId = items.map(scheduleItemMapTripPlaceId).find(Boolean);
  const summary = formatDayWorkspaceSummary(dayWorkspaceSummary(trip, day));
  const dayTitle = visibleUserText(day.title) ?? `Day ${day.dayNumber}`;
  return (
    <section className="timeline">
      <header className="timeline__intro">
        <p className="timeline__kicker">
          {dayIsCurrentTravelDay(trip, day) ? '今天' : `Day ${day.dayNumber}`}
        </p>
        <div className="timeline__heading">
          <h2>{dayTitle}</h2>
          {summary && <p className="timeline__summary">{summary}</p>}
        </div>
      </header>
      {mapNotice && <p className="timeline-map-notice" role="status">{mapNotice}</p>}
      {items.map((item) => {
        if (item.kind === 'rest' || item.kind === 'hotel_return' || item.kind === 'experience') {
          const title = scheduleHeading(item.kind, item.title);
          const description = visibleUserText(item.description);
          const safeDescription = description && !GENERIC_FREE.test(description) ? description : undefined;
          return (
            <div
              className={`timeline-item timeline-item--soft${item.kind === 'rest' || item.kind === 'hotel_return' ? ` timeline-item--${item.kind}` : ' timeline-item--experience'}`}
              key={item.id}
            >
              <time>{item.startTime}</time>
              <div>
                <h3>{title}</h3>
                {safeDescription && <p className="timeline-item__copy">{safeDescription}</p>}
              </div>
            </div>
          );
        }
        if (item.kind === 'area_walk') {
          const optionNames = item.optionTripPlaceIds
            .map((id) => visibleUserText(placeById.get(id)?.placeName))
            .filter((name): name is string => Boolean(name));
          return (
            <div className="timeline-item timeline-item--soft timeline-item--area-walk" key={item.id}>
              <time>{item.startTime}</time>
              <div>
                <h3>{visibleUserText(item.title) ?? '区域漫步'}</h3>
                {visibleUserText(item.description) && <p className="timeline-item__copy">{visibleUserText(item.description)}</p>}
                {optionNames.length > 0 && (
                  <ul className="timeline-chips">
                    {optionNames.map((name) => <li key={name}>{name}</li>)}
                  </ul>
                )}
              </div>
            </div>
          );
        }
        if (item.kind === 'meal_slot') {
          const area = placeById.get(item.areaTripPlaceId);
          const next = item.nextTripPlaceId ? placeById.get(item.nextTripPlaceId) : undefined;
          const period = mealPeriodTitle(item.mealPeriod, 'meal_slot');
          const areaName = visibleUserText(area?.placeName) ?? '当前区域';
          return (
            <div className="timeline-item timeline-item--meal-slot" id={`meal-slot-${item.id}`} key={item.id}>
              <time>{item.startTime}</time>
              <div>
                <h3>
                  {period} · {areaName}附近
                  {item.diningMode === 'flexible' && <span className="timeline-item__tag">柔性餐饮</span>}
                </h3>
                <p>预留 {formatCompactDuration(item.durationMinutes) || formatDuration(item.durationMinutes)}</p>
                {next && <p>位于当前安排与{next.placeName}之间</p>}
                {item.diningMode === 'flexible' && onOpenMeal && (
                  <button
                    className="timeline-meal-action"
                    type="button"
                    onClick={(event) => onOpenMeal(item, event.currentTarget)}
                  >
                    看看吃什么
                  </button>
                )}
              </div>
            </div>
          );
        }
        const place = placeById.get(item.tripPlaceId);
        if (!place) {
          return null;
        }
        const selected = place.id === selectedTripPlaceId;
        const featured = selected || (!selectedTripPlaceId && place.id === firstPlaceId);
        const mealLabel = (item.kind === 'meal' || item.kind === 'meal_place')
          ? mealPeriodTitle(item.mealPeriod, item.kind)
          : tripPlaceTypeLabel[place.type];
        const stay = place.durationMinutes
          ? formatCompactDuration(place.durationMinutes) || formatDuration(place.durationMinutes)
          : undefined;
        const description = visibleUserText(place.description);
        const safePlaceDescription = description && !GENERIC_FREE.test(description) ? description : undefined;
        return (
          <div
            className={`timeline-item${featured ? ' timeline-item--selected' : ''}`}
            data-selected={selected || undefined}
            id={`trip-stop-${place.id}`}
            key={`${item.kind}-${place.id}`}
            tabIndex={-1}
          >
            <time>{place.startTime ?? item.startTime ?? '时间待定'}</time>
            <div>
              <div className="timeline-item__heading">
                <h3 className="timeline-item__title">{place.placeName}</h3>
                {onPlaceSelect && (
                  <button className="timeline-map-action" type="button" aria-label={`在地图查看 ${place.placeName}`} onClick={() => onPlaceSelect(place.id)}>在地图查看</button>
                )}
              </div>
              <p>{mealLabel}{stay ? ` · 建议停留 ${stay}` : ''}</p>
              {safePlaceDescription && <p className="timeline-item__copy">{safePlaceDescription}</p>}
              {place.transportToNext && (
                <p className="transport">↓ {transportLabels[place.transportToNext.mode]} {formatDuration(place.transportToNext.durationMinutes)} · {formatDistance(place.transportToNext.distanceMeters)}</p>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
