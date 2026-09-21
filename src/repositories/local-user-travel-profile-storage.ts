import {
  USER_TRAVEL_PROFILE_STORAGE_KEY,
  USER_TRAVEL_PROFILE_VERSION,
  cloneUserTravelProfile,
  emptyUserTravelProfile,
  explicitProfileSignals,
  mergeProfileSignals,
  parseTravelProfileSignals,
  type TravelProfilePatchV1,
  type UserTravelProfileV1,
} from '../domain/trip/profile';
import type { TripStorage } from './local-trip-storage';

export const USER_TRAVEL_PROFILE_SESSION_ONLY_NOTICE = '旅行偏好仅保存在当前会话中。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseUserTravelProfileStore(value: unknown): UserTravelProfileV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || value.version !== USER_TRAVEL_PROFILE_VERSION
    || typeof value.updatedAt !== 'string'
    || value.updatedAt.trim() === ''
    || value.updatedAt.length > 40
  ) {
    return undefined;
  }
  const signals = parseTravelProfileSignals(value.signals);
  if (!signals) {
    return undefined;
  }
  return {
    version: USER_TRAVEL_PROFILE_VERSION,
    signals,
    updatedAt: value.updatedAt,
  };
}

export function serializeUserTravelProfile(profile: UserTravelProfileV1): UserTravelProfileV1 {
  return cloneUserTravelProfile(profile);
}

export function readUserTravelProfileStore(storage: TripStorage | null): UserTravelProfileV1 {
  if (!storage) {
    return emptyUserTravelProfile();
  }
  try {
    const raw = storage.getItem(USER_TRAVEL_PROFILE_STORAGE_KEY);
    if (!raw) {
      return emptyUserTravelProfile();
    }
    const parsed = parseUserTravelProfileStore(JSON.parse(raw) as unknown);
    return parsed ? cloneUserTravelProfile(parsed) : emptyUserTravelProfile();
  } catch {
    return emptyUserTravelProfile();
  }
}

export function writeUserTravelProfileStore(
  storage: TripStorage | null,
  profile: UserTravelProfileV1,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      USER_TRAVEL_PROFILE_STORAGE_KEY,
      JSON.stringify(serializeUserTravelProfile(profile)),
    );
    return true;
  } catch {
    return false;
  }
}

export function applyExplicitProfilePatch(
  current: UserTravelProfileV1,
  patch: TravelProfilePatchV1,
  nowIso: string,
): UserTravelProfileV1 {
  return {
    version: USER_TRAVEL_PROFILE_VERSION,
    signals: mergeProfileSignals(current.signals, explicitProfileSignals(patch.signals)),
    updatedAt: nowIso,
  };
}
