import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Place, Trip, TripScheduleItem } from '../../domain/trip/types';
import { getDefaultTripDayId } from '../../services/trip-display';
import { isWorkspaceSplitViewport } from '../../services/trip-workspace-layout';
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
  assistantLayoutForViewport,
  beginApply,
  beginInterpret,
  canSubmitAssistant,
  closeAssistant,
  createAssistantUiState,
  discardAssistantPlaceContext,
  markApplied,
  markFailed,
  openAssistant,
  restoreFailedDraft,
  showChoices,
  showClarification,
} from '../../services/trip-assistant-session';
import {
  noticeForTripChangeError,
  isSemanticTripChangeError,
  tripChangeService,
  TRIP_CHANGE_SAVE_FAILED_NOTICE,
  TRIP_CHANGE_STALE_NOTICE,
  type TripChangeService,
} from '../../services/trip-change-service';
import type { ReplacePlaceSummary } from '../../services/bff-trip-change-service';
import type { SelectMealPlaceSummary } from '../../services/bff-trip-meal-service';
import { tripMealService, type BffTripMealService } from '../../services/bff-trip-meal-service';
import { TripMap } from './TripMap';
import { TripMapRail } from './TripMapRail';
import { AskSuixingButton } from './AskSuixingButton';
import { TripAssistantSheet } from './TripAssistantSheet';
import { TripHero } from './TripHero';
import { TripDaySwitcher } from './TripDaySwitcher';
import { ItineraryTimeline } from './ItineraryTimeline';
import { MealOptionsSheet } from './MealOptionsSheet';
import { MEAL_APPLY_FAILED_NOTICE } from '../../services/meal-options-display';
import { subscribeKeyboardInset } from '../../services/mobile-viewport';
import {
  askSuixingExamples,
  askSuixingPlaceholder,
} from '../../services/ask-suixing-display';

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
    applyingPlaceId?: string | null;
    applyError?: string | null;
  }>(null);
  const [assistant, setAssistant] = useState(() => createAssistantUiState(
    assistantLayoutForViewport(),
  ));
  const requestLock = useRef(false);
  const askTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mealTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => subscribeKeyboardInset().disconnect, []);

  useEffect(() => {
    setDayId(getDefaultTripDayId(trip));
    setView('itinerary');
    setSelectedTripPlaceId(null);
    setSelectionSource(null);
    setMapNotice(null);
    setMealSheet(null);
    setAssistant((state) => createAssistantUiState(state.layout));
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
      setAssistant((state) => discardAssistantPlaceContext(state));
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
    if (!isWorkspaceSplitViewport()) {
      setView('map');
    }
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
      const intent = await changeService.interpret(text, submittedTrip, {
        selectedDayNumber: day?.dayNumber,
        sourceTripPlaceId: day?.places.some((place) => place.id === assistant.sessionHint?.sourceTripPlaceId)
          ? assistant.sessionHint?.sourceTripPlaceId
          : undefined,
      });
      if (intent.status === 'needs_choice') {
        setAssistant((state) => showChoices(
          state,
          intent.summary,
          intent.candidates ?? [],
          intent.pendingReplace,
        ));
        return;
      }
      if (intent.status === 'needs_clarification' || !isReadyReplaceIntent(intent)) {
        setAssistant((state) => showClarification(state, intent.summary, intent.sourceChoices ?? []));
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
      const notice = error instanceof Error && error.message === TRIP_CHANGE_STALE_NOTICE
        ? TRIP_CHANGE_STALE_NOTICE
        : noticeForTripChangeError(error);
      setAssistant((state) => (
        isSemanticTripChangeError(error)
          ? showClarification(state, notice)
          : markFailed(state, notice)
      ));
    } finally {
      requestLock.current = false;
    }
  }, [assistant, changeService, day?.dayNumber, onCommitChange, places, trip]);

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
    setMealSheet({ slot, places: [], status: 'loading', category, applyingPlaceId: null, applyError: null });
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
        applyingPlaceId: null,
        applyError: null,
      });
    } catch {
      setMealSheet({ slot, places: [], status: 'error', category });
    }
  }, [day, mealService, places, trip.destination]);

  const handleSelectMeal = useCallback(async (placeId: string) => {
    if (!mealSheet || requestLock.current || mealSheet.applyingPlaceId) {
      return;
    }
    if (!mealSheet.places.some((place) => place.id === placeId)) {
      setMealSheet((current) => current
        ? { ...current, applyingPlaceId: null, applyError: MEAL_APPLY_FAILED_NOTICE }
        : current);
      return;
    }
    requestLock.current = true;
    setMealSheet((current) => current
      ? { ...current, applyingPlaceId: placeId, applyError: null }
      : current);
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
      setMealSheet((current) => current
        ? { ...current, applyingPlaceId: null, applyError: MEAL_APPLY_FAILED_NOTICE }
        : current);
    } finally {
      requestLock.current = false;
    }
  }, [day?.dayNumber, mealService, mealSheet, onCommitChange, places, trip]);

  const handleSelectCandidate = useCallback(async (candidate: {
    placeId: string;
    name: string;
  }) => {
    if (!canSubmitAssistant(assistant) || requestLock.current || !assistant.pendingReplace) {
      return;
    }
    const submittedTrip = trip;
    const submittedPlaces = [...places];
    const expectedTripId = submittedTrip.id;
    const operation = {
      type: 'REPLACE_PLACE' as const,
      dayNumber: assistant.pendingReplace.dayNumber,
      targetTripPlaceId: assistant.pendingReplace.targetTripPlaceId,
      replacementQuery: candidate.placeId,
    };
    requestLock.current = true;
    setAssistant((state) => beginApply(state));
    try {
      const result = await changeService.apply({
        trip: submittedTrip,
        places: submittedPlaces,
        operation,
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
      setAssistant((state) => markFailed(state, noticeForTripChangeError(error)));
    } finally {
      requestLock.current = false;
    }
  }, [assistant, changeService, onCommitChange, places, trip]);

  const openAsk = (event: MouseEvent<HTMLButtonElement>) => {
    if (mealSheet?.applyingPlaceId) {
      return;
    }
    askTriggerRef.current = event.currentTarget;
    setMealSheet(null);
    setAssistant((state) => openAssistant(state));
  };

  const closeAsk = () => {
    setAssistant((state) => {
      const next = closeAssistant(state);
      if (state.open && !next.open) {
        const trigger = askTriggerRef.current;
        window.requestAnimationFrame(() => trigger?.focus());
      }
      return next;
    });
  };

  const map = day ? (
    <TripMap
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
      layoutSignal={view}
    />
  ) : null;

  return <section className="workspace">
    <TripHero trip={trip} />
    {!day ? <EmptyItinerary /> : <>
      <nav className="trip-nav" aria-label="旅行功能">
        <button type="button" aria-current={view === 'itinerary' ? 'page' : undefined} onClick={() => setView('itinerary')}>行程</button>
        <button type="button" aria-current={view === 'map' ? 'page' : undefined} onClick={() => setView('map')}>地图</button>
        <span aria-disabled="true">预订（即将接入）</span>
      </nav>
      <TripDaySwitcher trip={trip} day={day} onSelect={setDayId} />
      <div className={`day-workspace day-workspace--${view}`}>
        <div className="day-workspace__timeline">
          <ItineraryTimeline
            trip={trip}
            day={day}
            selectedTripPlaceId={selectedTripPlaceId}
            mapNotice={mapNotice}
            onPlaceSelect={handleTimelinePlaceSelect}
            onOpenMeal={(slot, trigger) => {
              if (assistant.open && !canSubmitAssistant(assistant)) {
                return;
              }
              mealTriggerRef.current = trigger ?? null;
              setAssistant((state) => closeAssistant(state));
              void loadMealOptions(slot, 'nearby');
            }}
          />
        </div>
        <TripMapRail
          map={map}
          action={(
            <AskSuixingButton
              label="问随行 · 调整这一天"
              onClick={openAsk}
            />
          )}
        />
      </div>
    </>}
    <div
      className={[
        'ask-suixing-entry-slot',
        'ask-suixing-entry-slot--mobile',
        assistant.open || mealSheet ? 'ask-suixing-entry-slot--hidden' : '',
      ].filter(Boolean).join(' ')}
    >
      <AskSuixingButton
        label="问随行 · 调整这一天"
        onClick={openAsk}
      />
    </div>
    <TripAssistantSheet
      state={assistant}
      trip={trip}
      day={day}
      examples={day ? askSuixingExamples(day) : []}
      placeholder={day ? askSuixingPlaceholder(day) : '例如：把今天下午的博物馆换成公园'}
      onClose={closeAsk}
      onDraftChange={(value) => setAssistant((state) => ({ ...state, draft: value, error: null }))}
      onRestoreDraft={() => setAssistant((state) => restoreFailedDraft(state))}
      onSelectCandidate={(candidate) => {
        void handleSelectCandidate(candidate);
      }}
      onSelectSource={(choice) => setAssistant((state) => ({
        ...state,
        draft: `把「${choice.placeName}」换成`,
        sessionHint: {
          selectedDayNumber: day?.dayNumber,
          sourceTripPlaceId: choice.tripPlaceId,
        },
      }))}
      onSubmit={() => {
        void handleSubmitChange();
      }}
    />
    {mealSheet && !assistant.open && (
      <MealOptionsSheet
        slot={mealSheet.slot}
        areaName={day?.places.find((place) => place.id === mealSheet.slot.areaTripPlaceId)?.placeName ?? '当前区域'}
        options={mealSheet.places}
        status={mealSheet.status}
        category={mealSheet.category}
        applyingPlaceId={mealSheet.applyingPlaceId}
        applyError={mealSheet.applyError}
        nextName={
          mealSheet.slot.nextTripPlaceId
            ? day?.places.find((place) => place.id === mealSheet.slot.nextTripPlaceId)?.placeName
            : undefined
        }
        onClose={() => {
          setMealSheet(null);
          const trigger = mealTriggerRef.current;
          mealTriggerRef.current = null;
          window.requestAnimationFrame(() => trigger?.focus());
        }}
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

function EmptyItinerary() {
  return <section className="empty-itinerary"><h2>旅行已创建</h2><p>行程正在准备中</p><p>你已经确认了旅行需求。下一阶段将根据地点、偏好和路线生成每日安排。</p></section>;
}
