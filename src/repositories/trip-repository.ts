import type { TripChange } from '../domain/trip/trip-change';
import type { Place, Trip } from '../domain/trip/types';
import type { TripRequirementDraft } from '../domain/trip/ai';
import type { TravelProfileSignals } from '../domain/trip/profile';

export interface CreateTripInput {
  userId: string;
  requirements: TripRequirementDraft & {
    destination: string;
    travelerCount: number;
    totalBudget: number;
    pace: NonNullable<TripRequirementDraft['pace']>;
    profileSignals?: TravelProfileSignals;
  };
}

export const TRIP_REPOSITORY_INVALID_REQUEST_MESSAGE = '行程地点数据不完整，请稍后重试。';

export class TripRepositoryError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'TripRepositoryError';
  }
}

export function referencedPlaceIdsInTripOrder(trip: Trip): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const day of trip.days) {
    const ordered = [...day.places].sort((left, right) => left.order - right.order);
    for (const place of ordered) {
      if (seen.has(place.placeId)) {
        continue;
      }
      seen.add(place.placeId);
      ids.push(place.placeId);
    }
  }
  return ids;
}

export interface TripRepository {
  getCurrentTrip(): Promise<Trip>;
  getTripById(tripId: string): Promise<Trip | null>;
  getTripChangePreview(tripId: string): Promise<TripChange | null>;
  getTripsByUserId(userId: string): Promise<Trip[]>;
  createTrip(input: CreateTripInput): Promise<Trip>;
  saveTrip(trip: Trip): Promise<Trip>;
  saveGeneratedTrip(input: { trip: Trip; places: Place[] }): Promise<Trip>;
  getPlacesForTrip(tripId: string): Promise<Place[]>;
  deleteTrip(tripId: string): Promise<void>;
}
