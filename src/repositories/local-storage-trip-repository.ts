import { mockTrips } from '../mocks/trips';
import type { Place, Trip } from '../domain/trip/types';
import {
  browserTripStorage,
  noteTripPersistenceFailure,
  readTripRepositoryStore,
  writeTripRepositoryStore,
  type StoredTripRecord,
  type TripStorage,
} from './local-trip-storage';
import { MockTripRepository } from './mock-trip-repository';
import type { CreateTripInput, TripRepository } from './trip-repository';
import type { TripChange } from '../domain/trip/trip-change';

const seedTripIds = new Set(mockTrips.map((trip) => trip.id));

export class LocalStorageTripRepository implements TripRepository {
  private readonly persistableIds = new Set<string>();
  private readonly removedSeedIds = new Set<string>();

  constructor(
    private readonly inner: MockTripRepository = new MockTripRepository(),
    private readonly storage: TripStorage | null = browserTripStorage(),
  ) {
    this.hydrate();
  }

  private hydrate(): void {
    const stored = readTripRepositoryStore(this.storage);
    for (const seedId of stored.removedSeedIds) {
      if (!seedTripIds.has(seedId)) {
        continue;
      }
      this.removedSeedIds.add(seedId);
      this.inner.removeTrip(seedId);
    }
    for (const record of stored.records) {
      this.removedSeedIds.delete(record.trip.id);
      this.persistableIds.add(record.trip.id);
      this.inner.replaceGeneratedTrip(record);
    }
  }

  private persistCurrent(): void {
    const records: StoredTripRecord[] = [];
    for (const id of [...this.persistableIds]) {
      const trip = this.inner.readTrip(id);
      if (!trip) {
        this.persistableIds.delete(id);
        continue;
      }
      records.push({
        trip,
        places: this.inner.readPlaces(id),
      });
    }
    if (!this.storage) {
      return;
    }
    const wrote = writeTripRepositoryStore(this.storage, {
      version: 1,
      records,
      removedSeedIds: [...this.removedSeedIds],
    });
    if (!wrote) {
      noteTripPersistenceFailure();
    }
  }

  private markPersistable(tripId: string): void {
    this.persistableIds.add(tripId);
    this.removedSeedIds.delete(tripId);
  }

  async getCurrentTrip(): Promise<Trip> {
    return this.inner.getCurrentTrip();
  }

  async getTripById(tripId: string): Promise<Trip | null> {
    return this.inner.getTripById(tripId);
  }

  async getTripChangePreview(tripId: string): Promise<TripChange | null> {
    return this.inner.getTripChangePreview(tripId);
  }

  async getTripsByUserId(userId: string): Promise<Trip[]> {
    return this.inner.getTripsByUserId(userId);
  }

  async createTrip(input: CreateTripInput): Promise<Trip> {
    const created = await this.inner.createTrip(input);
    this.markPersistable(created.id);
    this.persistCurrent();
    return created;
  }

  async saveTrip(trip: Trip): Promise<Trip> {
    const saved = await this.inner.saveTrip(trip);
    this.markPersistable(saved.id);
    this.persistCurrent();
    return saved;
  }

  async saveGeneratedTrip(input: { trip: Trip; places: Place[] }): Promise<Trip> {
    const saved = await this.inner.saveGeneratedTrip(input);
    this.markPersistable(saved.id);
    this.persistCurrent();
    return saved;
  }

  async getPlacesForTrip(tripId: string): Promise<Place[]> {
    return this.inner.getPlacesForTrip(tripId);
  }

  async deleteTrip(tripId: string): Promise<void> {
    await this.inner.deleteTrip(tripId);
    this.persistableIds.delete(tripId);
    if (seedTripIds.has(tripId)) {
      this.removedSeedIds.add(tripId);
    }
    this.persistCurrent();
  }
}

export const tripRepository: TripRepository = new LocalStorageTripRepository();
