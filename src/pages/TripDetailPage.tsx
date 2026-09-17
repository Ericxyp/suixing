import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/common/States';
import { TripWorkspace } from '../components/trip/TripWorkspace';
import type { Place, Trip } from '../domain/trip/types';
import { tripRepository } from '../repositories/local-storage-trip-repository';
import { consumeTripPersistenceNotice } from '../repositories/local-trip-storage';
import { referencedPlaceIdsInTripOrder } from '../repositories/trip-repository';
import type { DataState } from '../services/data-state';
import type { ReplacePlaceSummary } from '../services/bff-trip-change-service';
import type { SelectMealPlaceSummary } from '../services/bff-trip-meal-service';
import {
  appliedToastLabel,
  persistAppliedTripChange,
  restoreTripChangeSnapshot,
  TripChangeStaleError,
  TRIP_CHANGE_SAVE_FAILED_NOTICE,
  TRIP_CHANGE_STALE_NOTICE,
  TRIP_CHANGE_UNDO_FAILED_NOTICE,
  TRIP_CHANGE_UNDONE_NOTICE,
  UNDO_TOAST_MS,
} from '../services/trip-change-service';

const PLACES_LOAD_ERROR_MESSAGE = '旅行地点读取失败，请稍后重试。';

interface TripWorkspaceData {
  trip: Trip;
  places: Place[];
}

interface ChangeToast {
  kind: 'applied' | 'undone';
  text: string;
  canUndo: boolean;
}

export function TripDetailPage() {
  const { tripId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const createdFromPlan = (location.state as { createdFromPlan?: boolean } | null)?.createdFromPlan === true;
  const [notice, setNotice] = useState<string | null>(createdFromPlan ? '行程已生成' : null);
  const [changeToast, setChangeToast] = useState<ChangeToast | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [tripState, setTripState] = useState<DataState<TripWorkspaceData>>({ status: 'loading' });
  const undoSnapshot = useRef<{ trip: Trip; places: Place[] } | null>(null);

  useEffect(() => {
    if (!createdFromPlan) {
      return;
    }
    navigate('.', { replace: true, state: {} });
    setNotice('行程已生成');
  }, [createdFromPlan, navigate]);

  useEffect(() => {
    undoSnapshot.current = null;
    setChangeToast(null);
    setSaveNotice(null);
  }, [tripId]);

  useEffect(() => {
    if (!changeToast) {
      return;
    }
    const timer = window.setTimeout(() => {
      setChangeToast(null);
      undoSnapshot.current = null;
    }, UNDO_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [changeToast]);

  const loadTrip = useCallback(() => {
    let active = true;

    if (!tripId) {
      setTripState({ status: 'not-found' });
      return () => { active = false; };
    }

    setTripState({ status: 'loading' });
    Promise.all([
      tripRepository.getTripById(tripId),
      tripRepository.getPlacesForTrip(tripId),
    ])
      .then(([trip, places]) => {
        if (!active) {
          return;
        }
        if (!trip) {
          setTripState({ status: 'not-found' });
          return;
        }
        const referenced = referencedPlaceIdsInTripOrder(trip);
        const loadedIds = new Set(places.map((place) => place.id));
        if (referenced.some((placeId) => !loadedIds.has(placeId))) {
          setTripState({
            status: 'error',
            error: new Error(PLACES_LOAD_ERROR_MESSAGE),
          });
          return;
        }
        setTripState({ status: 'success', data: { trip, places } });
        setSaveNotice(consumeTripPersistenceNotice());
      })
      .catch((error: unknown) => {
        if (active) {
          setTripState({
            status: 'error',
            error: error instanceof Error ? error : new Error(PLACES_LOAD_ERROR_MESSAGE),
          });
        }
      });

    return () => { active = false; };
  }, [tripId]);

  useEffect(() => loadTrip(), [loadTrip]);

  const handleCommitChange = useCallback(async (input: {
    trip: Trip;
    places: Place[];
    summary: ReplacePlaceSummary | SelectMealPlaceSummary;
    previous: { trip: Trip; places: Place[] };
  }) => {
    if (!tripId || input.previous.trip.id !== tripId || input.trip.id !== tripId) {
      throw new TripChangeStaleError();
    }
    try {
      const saved = await persistAppliedTripChange(tripRepository, {
        currentTripId: tripId,
        trip: input.trip,
        places: input.places,
      });
      setSaveNotice(consumeTripPersistenceNotice());
      setTripState({ status: 'success', data: saved });
      undoSnapshot.current = {
        trip: structuredClone(input.previous.trip),
        places: structuredClone(input.previous.places),
      };
      setChangeToast({
        kind: 'applied',
        text: appliedToastLabel(input.summary),
        canUndo: true,
      });
    } catch (error) {
      if (error instanceof TripChangeStaleError) {
        setSaveNotice(TRIP_CHANGE_STALE_NOTICE);
        throw error;
      }
      setSaveNotice(TRIP_CHANGE_SAVE_FAILED_NOTICE);
      throw new Error(TRIP_CHANGE_SAVE_FAILED_NOTICE);
    }
  }, [tripId]);

  const handleUndo = useCallback(async () => {
    const snapshot = undoSnapshot.current;
    if (!snapshot || !tripId || snapshot.trip.id !== tripId) {
      setChangeToast(null);
      return;
    }
    try {
      const restored = await restoreTripChangeSnapshot(tripRepository, snapshot, tripId);
      setSaveNotice(consumeTripPersistenceNotice());
      setTripState({ status: 'success', data: restored });
      undoSnapshot.current = null;
      setChangeToast({
        kind: 'undone',
        text: TRIP_CHANGE_UNDONE_NOTICE,
        canUndo: false,
      });
    } catch {
      setSaveNotice(TRIP_CHANGE_UNDO_FAILED_NOTICE);
    }
  }, [tripId]);

  return (
    <section className="entry-page entry-page--workspace">
      <p className="eyebrow">旅行入口</p>
      {notice && (
        <p className="plan-toast" role="status">{notice}</p>
      )}
      {saveNotice && (
        <p className="plan-toast" role="status">{saveNotice}</p>
      )}
      {changeToast && (
        <p className="change-toast" role="status">
          {changeToast.text}
          {changeToast.canUndo && (
            <>
              {' · '}
              <button type="button" onClick={() => { void handleUndo(); }}>撤销</button>
            </>
          )}
        </p>
      )}
      {tripState.status === 'loading' && <LoadingState label="正在读取这趟旅行…" />}
      {tripState.status === 'error' && <ErrorState message={tripState.error.message} onRetry={loadTrip} />}
      {tripState.status === 'not-found' && (
        <>
          <h1>这趟旅行不存在或已不可用</h1>
          <p>请回到首页，选择另一趟旅行。</p>
        </>
      )}
      {tripState.status === 'success' && (
        <TripWorkspace
          trip={tripState.data.trip}
          places={tripState.data.places}
          onCommitChange={handleCommitChange}
        />
      )}
      <Link className="text-link" to="/">返回首页</Link>
    </section>
  );
}
