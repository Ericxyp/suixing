import type { UserTravelProfileRepository } from '../services/user-travel-profile-repository';
import {
  applyExplicitProfilePatch,
  readUserTravelProfileStore,
  writeUserTravelProfileStore,
} from './local-user-travel-profile-storage';
import { browserTripStorage, type TripStorage } from './local-trip-storage';
import {
  cloneUserTravelProfile,
  emptyUserTravelProfile,
  type TravelProfilePatchV1,
  type UserTravelProfileV1,
} from '../domain/trip/profile';

export class LocalStorageUserTravelProfileRepository implements UserTravelProfileRepository {
  constructor(private readonly storage: TripStorage | null = browserTripStorage()) {}

  async load(): Promise<UserTravelProfileV1> {
    return cloneUserTravelProfile(readUserTravelProfileStore(this.storage));
  }

  async saveExplicitPatch(
    patch: TravelProfilePatchV1,
    nowIso = new Date().toISOString(),
  ): Promise<UserTravelProfileV1> {
    const current = readUserTravelProfileStore(this.storage);
    const next = applyExplicitProfilePatch(current, patch, nowIso);
    writeUserTravelProfileStore(this.storage, next);
    return cloneUserTravelProfile(next);
  }
}

export const userTravelProfileRepository = new LocalStorageUserTravelProfileRepository();

export function emptyTravelProfile(): UserTravelProfileV1 {
  return emptyUserTravelProfile();
}
