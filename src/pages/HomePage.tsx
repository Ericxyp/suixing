import { useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '../components/common/States';
import { CreateTripEntry } from '../components/home/CreateTripEntry';
import { RecentTripsSection } from '../components/home/RecentTripsSection';
import { SavedItemsSection } from '../components/home/SavedItemsSection';
import type { SavedItem } from '../domain/saved-items/types';
import type { Trip } from '../domain/trip/types';
import { tripRepository } from '../repositories/local-storage-trip-repository';
import {
  consumeTripPersistenceNotice,
  selectRecentTrips,
} from '../repositories/local-trip-storage';
import { savedItemRepository } from '../repositories/mock-saved-item-repository';
import type { DataState } from '../services/data-state';

const demoUserId = 'user-demo-001';

export function HomePage() {
  const [tripState, setTripState] = useState<DataState<Trip[]>>({ status: 'loading' });
  const [savedItemsState, setSavedItemsState] = useState<DataState<SavedItem[]>>({ status: 'loading' });
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);

  const loadData = useCallback(() => {
    let active = true;

    setTripState({ status: 'loading' });
    setSavedItemsState({ status: 'loading' });
    setPersistenceNotice(consumeTripPersistenceNotice());
    tripRepository.getTripsByUserId(demoUserId)
      .then((trips) => {
        if (active) {
          setTripState(trips.length ? { status: 'success', data: trips } : { status: 'empty' });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setTripState({
            status: 'error',
            error: error instanceof Error ? error : new Error('旅行数据读取失败。'),
          });
        }
      });
    savedItemRepository.getSavedItems(demoUserId)
      .then((items) => {
        if (active) {
          setSavedItemsState(items.length ? { status: 'success', data: items } : { status: 'empty' });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setSavedItemsState({
            status: 'error',
            error: error instanceof Error ? error : new Error('收藏读取失败。'),
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => loadData(), [loadData]);

  async function deleteTrip(tripId: string) {
    await tripRepository.deleteTrip(tripId);
    setPersistenceNotice(consumeTripPersistenceNotice());
    const trips = await tripRepository.getTripsByUserId(demoUserId);
    setTripState(trips.length ? { status: 'success', data: trips } : { status: 'empty' });
  }

  const recentTrips = tripState.status === 'success'
    ? selectRecentTrips(tripState.data)
    : [];

  return (
    <div className="home-page">
      <CreateTripEntry />
      {persistenceNotice && <p className="plan-toast" role="status">{persistenceNotice}</p>}
      {tripState.status === 'loading' && <LoadingState label="正在读取旅行…" />}
      {tripState.status === 'error' && <ErrorState message={tripState.error.message} onRetry={loadData} />}
      {(tripState.status === 'success' || tripState.status === 'empty') && (
        <RecentTripsSection trips={recentTrips} onDelete={(tripId) => { void deleteTrip(tripId); }} />
      )}
      {savedItemsState.status === 'loading' && <LoadingState label="正在读取收藏…" />}
      {savedItemsState.status === 'error' && <ErrorState message={savedItemsState.error.message} onRetry={loadData} />}
      {(savedItemsState.status === 'success' || savedItemsState.status === 'empty') && (
        <SavedItemsSection items={savedItemsState.status === 'success' ? savedItemsState.data : []} />
      )}
      <footer className="home-footer">
        <p>随行</p>
        <p>出发吧，去遇见更广阔的自己</p>
      </footer>
    </div>
  );
}
