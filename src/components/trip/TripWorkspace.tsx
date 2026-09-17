import { useCallback, useEffect, useRef, useState } from 'react';
import type { Place, Trip, TripDay, TripPlaceType, TripScheduleItem } from '../../domain/trip/types';
import { formatCurrency, formatDistance, formatDuration, formatTripDates, getDefaultTripDayId, itineraryTimelineItems, statusLabel } from '../../services/trip-display';
import {
  getTripMapStopByTripPlaceId,
  isTripPlaceInDay,
  retainSelectedTripPlaceId,
  shouldFocusMapForSelection,
  shouldScrollTimelineForSelection,
  type TripMapSelectionSource,
} from '../../services/trip-map';
import { isReadyReplaceIntent } from '../../services/bff-trip-change-service';
import {
  ASK_SUIXING_BREAKPOINT_PX,
  beginApply,
  beginInterpret,
  canSubmitAssistant,
  closeAssistant,
  createAssistantUiState,
  markApplied,
  markFailed,
  openAssistant,
  sheetLayoutForWidth,
  showClarification,
} from '../../services/trip-assistant-session';
import {
  noticeForTripChangeError,
  tripChangeService,
  TRIP_CHANGE_SAVE_FAILED_NOTICE,
  TRIP_CHANGE_STALE_NOTICE,
  type TripChangeService,
} from '../../services/trip-change-service';
import type { ReplacePlaceSummary } from '../../services/bff-trip-change-service';
import type { SelectMealPlaceSummary } from '../../services/bff-trip-meal-service';
import { tripMealService, type BffTripMealService } from '../../services/bff-trip-meal-service';
import { TripMap } from './TripMap';
import { AskSuixingButton } from './AskSuixingButton';
import { TripAssistantSheet } from './TripAssistantSheet';

const typeLabels: Record<TripPlaceType, string> = { hotel: '酒店', attraction: '景点', restaurant: '餐厅', cafe: '咖啡', transport: '交通', shopping: '购物', activity: '活动' };
const transportLabels = { walk: '步行', metro: '地铁', taxi: '打车', bus: '公交', drive: '驾车' };

export function TripWorkspace({
  trip,
  places,
  onCommitChange,
  changeService = tripChangeService,
  mealService = tripMealService,
}: {
  trip: Trip;
  places: readonly Place[];
  onCommitChange: (input: {
    trip: Trip;
    places: Place[];
    summary: ReplacePlaceSummary | SelectMealPlaceSummary;
    previous: { trip: Trip; places: Place[] };
  }) => Promise<void>;
  changeService?: TripChangeService;
  mealService?: BffTripMealService;
}) {
  const [dayId, setDayId] = useState(() => getDefaultTripDayId(trip));
  const [view, setView] = useState<'itinerary' | 'map'>('itinerary');
  const [selectedTripPlaceId, setSelectedTripPlaceId] = useState<string | null>(null);
  const [selectionSource, setSelectionSource] = useState<TripMapSelectionSource>(null);
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [mealSheet, setMealSheet] = useState<null | {
    slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>;
    places: Place[];
    status: 'loading' | 'ready' | 'empty' | 'error';
    category: 'nearby' | 'coffee';
  }>(null);
  const [assistant, setAssistant] = useState(() => createAssistantUiState(
    typeof window === 'undefined' ? 'side' : sheetLayoutForWidth(window.innerWidth),
  ));
  const requestLock = useRef(false);

  useEffect(() => {
    setDayId(getDefaultTripDayId(trip));
    setView('itinerary');
    setSelectedTripPlaceId(null);
    setSelectionSource(null);
    setMapNotice(null);
    setMealSheet(null);
  }, [trip.id]);

  useEffect(() => {
    setView('itinerary');
    setSelectedTripPlaceId(null);
    setSelectionSource(null);
    setMapNotice(null);
    setDayId((current) => (
      trip.days.some((item) => item.id === current) ? current : getDefaultTripDayId(trip)
    ));
  }, [trip.updatedAt]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(`(max-width: ${ASK_SUIXING_BREAKPOINT_PX}px)`);
    const sync = () => {
      setAssistant((state) => ({
        ...state,
        layout: media.matches ? 'bottom' : 'side',
      }));
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const day = trip.days.find((item) => item.id === dayId) ?? trip.days[0];

  useEffect(() => {
    if (day) {
      setSelectedTripPlaceId((selected) =>
        retainSelectedTripPlaceId(day, selected));
      setSelectionSource(null);
      setMapNotice(null);
    }
  }, [day?.id]);

  const handleMapStopSelect = useCallback((tripPlaceId: string) => {
    if (!day || !isTripPlaceInDay(day, tripPlaceId)) {
      return;
    }
    setMapNotice(null);
    setSelectedTripPlaceId(tripPlaceId);
    setSelectionSource('map');
    setView('itinerary');
  }, [day]);

  const handleTimelinePlaceSelect = useCallback((tripPlaceId: string) => {
    if (!day || !isTripPlaceInDay(day, tripPlaceId)) {
      return;
    }
    const stop = getTripMapStopByTripPlaceId(day, places, tripPlaceId);
    if (!stop) {
      setMapNotice('该地点暂时无法在地图上显示');
      return;
    }
    setMapNotice(null);
    setSelectedTripPlaceId(tripPlaceId);
    setSelectionSource('timeline');
    setView('map');
  }, [day, places]);

  const handleMapFocusHandled = useCallback((tripPlaceId: string) => {
    if (tripPlaceId !== selectedTripPlaceId) {
      return;
    }
    setSelectionSource((source) => source === 'timeline' ? null : source);
  }, [selectedTripPlaceId]);

  useEffect(() => {
    if (
      view !== 'itinerary'
      || !selectedTripPlaceId
      || !shouldScrollTimelineForSelection(selectionSource)
      || typeof document === 'undefined'
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(
        `trip-stop-${selectedTripPlaceId}`,
      );
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
      setSelectionSource((source) => source === 'map' ? null : source);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedTripPlaceId, selectionSource, view]);

  const handleSubmitChange = useCallback(async () => {
    if (!canSubmitAssistant(assistant) || requestLock.current) {
      return;
    }
    const text = assistant.draft;
    const submittedTrip = trip;
    const submittedPlaces = [...places];
    const expectedTripId = submittedTrip.id;
    requestLock.current = true;
    setAssistant((state) => beginInterpret(state, text));
    try {
      const intent = await changeService.interpret(text, submittedTrip);
      if (intent.status === 'needs_clarification' || !isReadyReplaceIntent(intent)) {
        setAssistant((state) => showClarification(state, intent.summary));
        return;
      }
      setAssistant((state) => beginApply(state));
      const result = await changeService.apply({
        trip: submittedTrip,
        places: submittedPlaces,
        operation: intent.operations[0],
        expectedTripId,
      });
      try {
        await onCommitChange({
          trip: result.trip,
          places: result.places,
          summary: result.summary,
          previous: { trip: submittedTrip, places: submittedPlaces },
        });
        setAssistant((state) => markApplied(state));
      } catch {
        setAssistant((state) => markFailed(state, TRIP_CHANGE_SAVE_FAILED_NOTICE));
      }
    } catch (error) {
      setAssistant((state) => markFailed(
        state,
        error instanceof Error && error.message === TRIP_CHANGE_STALE_NOTICE
          ? TRIP_CHANGE_STALE_NOTICE
          : noticeForTripChangeError(error),
      ));
    } finally {
      requestLock.current = false;
    }
  }, [assistant, changeService, onCommitChange, places, trip]);

  const loadMealOptions = useCallback(async (
    slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>,
    category: 'nearby' | 'coffee',
  ) => {
    if (!day) {
      return;
    }
    const areaStop = day.places.find((place) => place.id === slot.areaTripPlaceId);
    const areaPlace = places.find((place) => place.id === areaStop?.placeId);
    if (!areaPlace) {
      setMealSheet({ slot, places: [], status: 'error', category });
      return;
    }
    const nextStop = slot.nextTripPlaceId
      ? day.places.find((place) => place.id === slot.nextTripPlaceId)
      : undefined;
    const nextMapped = nextStop ? places.find((place) => place.id === nextStop.placeId) : undefined;
    setMealSheet({ slot, places: [], status: 'loading', category });
    try {
      const options = await mealService.listOptions({
        city: trip.destination,
        mealPeriod: slot.mealPeriod,
        area: {
          placeId: areaPlace.id,
          name: `${areaPlace.name}附近`,
          longitude: areaPlace.longitude,
          latitude: areaPlace.latitude,
        },
        ...(nextMapped
          ? {
            nextPlace: {
              placeId: nextMapped.id,
              name: nextMapped.name,
              longitude: nextMapped.longitude,
              latitude: nextMapped.latitude,
            },
          }
          : {}),
        ...(category === 'coffee' ? { category: 'coffee' as const } : {}),
      });
      setMealSheet({
        slot,
        places: options,
        status: options.length === 0 ? 'empty' : 'ready',
        category,
      });
    } catch {
      setMealSheet({ slot, places: [], status: 'error', category });
    }
  }, [day, mealService, places, trip.destination]);

  const handleSelectMeal = useCallback(async (placeId: string) => {
    if (!mealSheet || requestLock.current) {
      return;
    }
    requestLock.current = true;
    const previous = {
      trip: structuredClone(trip),
      places: structuredClone([...places]),
    };
    try {
      const result = await mealService.apply({
        trip,
        places: [...places],
        dayNumber: day?.dayNumber ?? 1,
        mealSlotId: mealSheet.slot.id,
        placeId,
        expectedTripId: trip.id,
      });
      await onCommitChange({
        trip: result.trip,
        places: result.places,
        summary: result.summary,
        previous,
      });
      setMealSheet(null);
    } catch {
      setMealSheet((current) => current ? { ...current, status: 'error' } : current);
    } finally {
      requestLock.current = false;
    }
  }, [day?.dayNumber, mealService, mealSheet, onCommitChange, places, trip]);

  return <section className="workspace">
    <header className="trip-header"><p className="eyebrow">{trip.destination} · {statusLabel[trip.status]}</p><h1>{trip.title}</h1><p>{formatTripDates(trip)} · {trip.travelerCount} 人 · 预算 {formatCurrency(trip.totalBudget)}</p></header>
    {!day ? <EmptyItinerary /> : <>
      <nav className="trip-nav" aria-label="旅行功能">
        <button type="button" aria-current={view === 'itinerary' ? 'page' : undefined} onClick={() => setView('itinerary')}>行程</button>
        <button type="button" aria-current={view === 'map' ? 'page' : undefined} onClick={() => setView('map')}>地图</button>
        <span>预订（即将接入）</span>
      </nav>
      <div className="day-switcher" role="tablist" aria-label="行程日期">{trip.days.map((item) => <button role="tab" aria-selected={item.id === day.id} key={item.id} type="button" onClick={() => setDayId(item.id)}>Day {item.dayNumber}<small>{item.date}</small></button>)}</div>
      {view === 'itinerary'
        ? <Timeline
            day={day}
            selectedTripPlaceId={selectedTripPlaceId}
            mapNotice={mapNotice}
            onPlaceSelect={handleTimelinePlaceSelect}
            onOpenMeal={(slot) => {
              void loadMealOptions(slot, 'nearby');
            }}
          />
        : <TripMap
            trip={trip}
            day={day}
            places={places}
            selectedTripPlaceId={selectedTripPlaceId}
            onStopSelect={handleMapStopSelect}
            focusTripPlaceId={
              shouldFocusMapForSelection(selectionSource)
                ? selectedTripPlaceId
                : null
            }
            onFocusHandled={handleMapFocusHandled}
          />}
    </>}
    <AskSuixingButton
      onClick={() => setAssistant((state) => openAssistant(state))}
    />
    <TripAssistantSheet
      state={assistant}
      onClose={() => setAssistant((state) => closeAssistant(state))}
      onDraftChange={(value) => setAssistant((state) => ({ ...state, draft: value, error: null }))}
      onSubmit={() => {
        void handleSubmitChange();
      }}
    />
    {mealSheet && (
      <MealOptionsSheet
        slot={mealSheet.slot}
        areaName={day?.places.find((place) => place.id === mealSheet.slot.areaTripPlaceId)?.placeName ?? '当前区域'}
        options={mealSheet.places}
        status={mealSheet.status}
        category={mealSheet.category}
        nextName={
          mealSheet.slot.nextTripPlaceId
            ? day?.places.find((place) => place.id === mealSheet.slot.nextTripPlaceId)?.placeName
            : undefined
        }
        onClose={() => setMealSheet(null)}
        onRetry={() => {
          void loadMealOptions(mealSheet.slot, mealSheet.category);
        }}
        onFilter={(category) => {
          void loadMealOptions(mealSheet.slot, category);
        }}
        onSelect={(placeId) => {
          void handleSelectMeal(placeId);
        }}
      />
    )}
  </section>;
}

function Timeline({
  day,
  selectedTripPlaceId,
  mapNotice,
  onPlaceSelect,
  onOpenMeal,
}: {
  day: TripDay;
  selectedTripPlaceId?: string | null;
  mapNotice?: string | null;
  onPlaceSelect?: (tripPlaceId: string) => void;
  onOpenMeal?: (slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>) => void;
}) {
  if (!day.places.length) return <p className="state-message">这一天的行程还在准备中。</p>;
  const items = itineraryTimelineItems(day);
  const placeById = new Map(day.places.map((place) => [place.id, place]));
  return <section className="timeline"><h2>{day.title ?? `Day ${day.dayNumber}`}</h2>{mapNotice && <p className="timeline-map-notice" role="status">{mapNotice}</p>}{items.map((item) => {
    if (item.kind === 'rest' || item.kind === 'hotel_return' || item.kind === 'experience') {
      return <div className={`timeline-item timeline-item--experience${item.kind === 'rest' || item.kind === 'hotel_return' ? ' timeline-item--rest' : ''}`} key={item.id}>
        <time>{item.startTime}</time>
        <div>
          <h3>{item.title}</h3>
          <p>{item.description}</p>
        </div>
      </div>;
    }
    if (item.kind === 'area_walk') {
      const optionNames = item.optionTripPlaceIds
        .map((id) => placeById.get(id)?.placeName)
        .filter((name): name is string => Boolean(name));
      return <div className="timeline-item timeline-item--experience" key={item.id}>
        <time>{item.startTime}</time>
        <div>
          <h3>{item.title}</h3>
          <p>{item.description}</p>
          {optionNames.length > 0 && <p>可选顺路点：{optionNames.join('、')}</p>}
        </div>
      </div>;
    }
    if (item.kind === 'meal_slot') {
      const area = placeById.get(item.areaTripPlaceId);
      const next = item.nextTripPlaceId ? placeById.get(item.nextTripPlaceId) : undefined;
      const period = item.mealPeriod === 'lunch' ? '午餐时间' : '晚餐时间';
      return <div className="timeline-item timeline-item--meal-slot" key={item.id}>
        <time>{item.startTime}</time>
        <div>
          <h3>{period} · {area?.placeName ?? '当前区域'}附近</h3>
          <p>预留 {formatDuration(item.durationMinutes)}</p>
          {next && <p>位于当前安排与{next.placeName}之间</p>}
          {item.diningMode === 'flexible' && onOpenMeal && (
            <button className="timeline-meal-action" type="button" onClick={() => onOpenMeal(item)}>看看吃什么</button>
          )}
        </div>
      </div>;
    }
    const tripPlaceId = item.tripPlaceId;
    const place = placeById.get(tripPlaceId);
    if (!place) {
      return null;
    }
    const selected = place.id === selectedTripPlaceId;
    const mealLabel = (item.kind === 'meal' || item.kind === 'meal_place')
      ? (item.mealPeriod === 'lunch' ? '午餐' : '晚餐')
      : typeLabels[place.type];
    return <div
      className={`timeline-item${selected ? ' timeline-item--selected' : ''}`}
      data-selected={selected || undefined}
      id={`trip-stop-${place.id}`}
      key={`${item.kind}-${place.id}`}
      tabIndex={-1}
    ><time>{place.startTime ?? item.startTime ?? '时间待定'}</time><div><div className="timeline-item__heading"><h3>{place.placeName}</h3>{onPlaceSelect && <button className="timeline-map-action" type="button" aria-label={`在地图查看 ${place.placeName}`} onClick={() => onPlaceSelect(place.id)}>在地图查看</button>}</div><p>{mealLabel}{place.durationMinutes ? ` · 建议停留 ${formatDuration(place.durationMinutes)}` : ''}</p>{place.description && <p>{place.description}</p>}{place.estimatedCost > 0 && <p>人均约 {formatCurrency(place.estimatedCost)}</p>}{place.transportToNext && <p className="transport">↓ {transportLabels[place.transportToNext.mode]} {formatDuration(place.transportToNext.durationMinutes)} · {formatDistance(place.transportToNext.distanceMeters)}</p>}</div></div>;
  })}</section>;
}

function MealOptionsSheet({
  slot,
  areaName,
  options,
  status,
  category,
  nextName,
  onClose,
  onRetry,
  onFilter,
  onSelect,
}: {
  slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>;
  areaName: string;
  options: Place[];
  status: 'loading' | 'ready' | 'empty' | 'error';
  category: 'nearby' | 'coffee';
  nextName?: string;
  onClose: () => void;
  onRetry: () => void;
  onFilter: (category: 'nearby' | 'coffee') => void;
  onSelect: (placeId: string) => void;
}) {
  const title = `${slot.mealPeriod === 'lunch' ? '午餐' : '晚餐'} · ${areaName}附近`;
  return (
    <div className="ask-suixing-layer ask-suixing-layer--side">
      <button className="ask-suixing-dismiss" type="button" aria-label="关闭餐饮选项" onClick={onClose} />
      <aside className="ask-suixing-sheet ask-suixing-sheet--side meal-options-sheet" role="dialog" aria-labelledby="meal-options-title">
        <header className="ask-suixing-sheet__header">
          <div>
            <p className="eyebrow">用餐安排</p>
            <h2 id="meal-options-title">{title}</h2>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <div className="meal-options-filters">
          <button type="button" aria-pressed={category === 'nearby'} onClick={() => onFilter('nearby')}>附近餐饮</button>
          <button type="button" aria-pressed={category === 'coffee'} onClick={() => onFilter('coffee')}>咖啡休息</button>
        </div>
        <div className="ask-suixing-sheet__stream">
          {status === 'loading' && <p className="ask-suixing-sheet__status" role="status">正在查找附近餐饮…</p>}
          {status === 'error' && (
            <p className="ask-suixing-sheet__status" role="status">
              暂时无法加载餐饮地点，请稍后重试。
              {' '}
              <button type="button" onClick={onRetry}>重试</button>
            </p>
          )}
          {status === 'empty' && (
            <p className="ask-suixing-sheet__empty">附近暂时没有合适的餐饮地点，你可以按自己的安排用餐。</p>
          )}
          {status === 'ready' && options.map((place) => (
            <div className="meal-option" key={place.id}>
              <div>
                <h3>{place.name}</h3>
                <p>{typeLabels[place.category]}{nextName ? ` · 顺路前往${nextName}` : ' · 靠近当前区域'}</p>
              </div>
              <button type="button" onClick={() => onSelect(place.id)}>加入行程</button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function EmptyItinerary() {
  return <section className="empty-itinerary"><h2>旅行已创建</h2><p>行程正在准备中</p><p>你已经确认了旅行需求。下一阶段将根据地点、偏好和路线生成每日安排。</p></section>;
}
