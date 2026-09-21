import type { UserTravelProfileV1, TravelProfilePatchV1 } from '../domain/trip/profile';

export interface UserTravelProfileRepository {
  load(): Promise<UserTravelProfileV1>;
  saveExplicitPatch(patch: TravelProfilePatchV1, nowIso?: string): Promise<UserTravelProfileV1>;
}
