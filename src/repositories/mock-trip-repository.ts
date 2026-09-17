import {
  referencedPlaceIdsInTripOrder,
  TRIP_REPOSITORY_INVALID_REQUEST_MESSAGE,
  TripRepositoryError,
  type CreateTripInput,
  type TripRepository,
} from './trip-repository';
import type { TripChange } from '../domain/trip/trip-change';
import type { Place, Trip } from '../domain/trip/types';
import { mockPlaces } from '../mocks/places';
import { mockShanghaiTripChangePreview } from '../mocks/trip-changes';
import { mockShanghaiTrip, mockTrips } from '../mocks/trips';

function placesForTrip(trip: Trip, catalog: readonly Place[]): Place[] {
  const byId = new Map(catalog.map((place) => [place.id, place]));
  const places: Place[] = [];
  for (const placeId of referencedPlaceIdsInTripOrder(trip)) {
    const place = byId.get(placeId);
    if (place) {
      places.push(structuredClone(place));
    }
  }
  return places;
}

export class MockTripRepository implements TripRepository {
  private trips: Trip[] = mockTrips.map((trip) => structuredClone(trip));
  private placesByTripId = new Map<string, Place[]>(
    mockTrips.map((trip) => [trip.id, placesForTrip(trip, mockPlaces)]),
  );
  private createdTripCount = 0;

  async getCurrentTrip(): Promise<Trip> {
    return structuredClone(this.trips.find((trip) => trip.status === 'PLANNING') ?? mockShanghaiTrip);
  }

  async getTripById(tripId: string): Promise<Trip | null> {
    const trip = this.trips.find((candidate) => candidate.id === tripId);
    return trip ? structuredClone(trip) : null;
  }

  async getTripChangePreview(tripId: string): Promise<TripChange | null> {
    return tripId === mockShanghaiTrip.id
      ? structuredClone(mockShanghaiTripChangePreview)
      : null;
  }

  async getTripsByUserId(userId: string): Promise<Trip[]> {
    return structuredClone(this.trips.filter((trip) => trip.userId === userId));
  }

  async createTrip({ userId, requirements }: CreateTripInput): Promise<Trip> {
    this.createdTripCount += 1;
    const id = `trip-local-${String(this.createdTripCount).padStart(3, '0')}`;
    const dayLabel = requirements.durationDays ? `${requirements.durationDays}天` : '日期待定';
    const trip: Trip = {
      id, userId, title: `${requirements.destination} · ${dayLabel}`,
      destination: requirements.destination, origin: requirements.origin,
      startDate: requirements.startDate, endDate: requirements.endDate,
      travelerCount: requirements.travelerCount, totalBudget: requirements.totalBudget,
      currency: 'CNY', pace: requirements.pace, preferences: requirements.preferences ?? { interests: [] },
      status: 'PLANNING', days: [], routes: [],
      createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    };
    this.trips.unshift(trip);
    this.placesByTripId.set(id, []);
    return structuredClone(trip);
  }

  async saveTrip(trip: Trip): Promise<Trip> {
    const stored = structuredClone(trip);
    const index = this.trips.findIndex((candidate) => candidate.id === stored.id);
    if (index >= 0) {
      this.trips[index] = stored;
    } else {
      this.trips.unshift(stored);
    }
    return structuredClone(stored);
  }

  async saveGeneratedTrip(input: { trip: Trip; places: Place[] }): Promise<Trip> {
    return this.replaceGeneratedTrip(input);
  }

  replaceGeneratedTrip(input: { trip: Trip; places: Place[] }): Trip {
    const trip = structuredClone(input.trip);
    const catalog = structuredClone(input.places);
    const referenced = referencedPlaceIdsInTripOrder(trip);
    const byId = new Map<string, Place>();
    for (const place of catalog) {
      if (referenced.includes(place.id) && !byId.has(place.id)) {
        byId.set(place.id, structuredClone(place));
      }
    }
    if (referenced.some((placeId) => !byId.has(placeId))) {
      throw new TripRepositoryError('INVALID_REQUEST', TRIP_REPOSITORY_INVALID_REQUEST_MESSAGE);
    }
    const places = referenced.map((placeId) => structuredClone(byId.get(placeId)!));
    const index = this.trips.findIndex((candidate) => candidate.id === trip.id);
    if (index >= 0) {
      this.trips[index] = trip;
    } else {
      this.trips.unshift(trip);
    }
    this.placesByTripId.set(trip.id, places);
    return structuredClone(trip);
  }

  readTrip(tripId: string): Trip | null {
    const trip = this.trips.find((candidate) => candidate.id === tripId);
    return trip ? structuredClone(trip) : null;
  }

  readPlaces(tripId: string): Place[] {
    const trip = this.trips.find((candidate) => candidate.id === tripId);
    if (!trip) {
      return [];
    }
    const stored = this.placesByTripId.get(tripId) ?? [];
    const allowed = new Set(referencedPlaceIdsInTripOrder(trip));
    return structuredClone(stored.filter((place) => allowed.has(place.id)));
  }

  removeTrip(tripId: string): void {
    this.trips = this.trips.filter((trip) => trip.id !== tripId);
    this.placesByTripId.delete(tripId);
  }

  async getPlacesForTrip(tripId: string): Promise<Place[]> {
    return this.readPlaces(tripId);
  }

  async deleteTrip(tripId: string): Promise<void> {
    this.removeTrip(tripId);
  }
}
