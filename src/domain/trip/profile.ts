export const TRAVEL_INTEREST_KEYS = [
  'history',
  'culture_art',
  'nature',
  'food',
  'coffee',
  'shopping',
  'photography',
  'nightlife',
  'local_life',
  'architecture',
] as const;

export const TRAVEL_BEHAVIOR_KEYS = [
  'pace',
  'walking_tolerance',
  'transfer_tolerance',
] as const;

export const TRAVEL_EXPERIENCE_KEYS = [
  'popular_vs_niche',
  'indoor_vs_outdoor',
] as const;

export const TRAVEL_PROFILE_DIMENSION_KEYS = [
  ...TRAVEL_INTEREST_KEYS,
  ...TRAVEL_BEHAVIOR_KEYS,
  ...TRAVEL_EXPERIENCE_KEYS,
] as const;

export type TravelInterestKey = typeof TRAVEL_INTEREST_KEYS[number];
export type TravelBehaviorKey = typeof TRAVEL_BEHAVIOR_KEYS[number];
export type TravelExperienceKey = typeof TRAVEL_EXPERIENCE_KEYS[number];
export type TravelProfileDimensionKey = typeof TRAVEL_PROFILE_DIMENSION_KEYS[number];

export const TRAVEL_PROFILE_SIGNAL_SOURCES = ['explicit', 'inferred', 'behavioral'] as const;
export type TravelProfileSignalSource = typeof TRAVEL_PROFILE_SIGNAL_SOURCES[number];

export const TRAVEL_PARTY_TYPES = [
  'solo',
  'couple',
  'friends',
  'parents',
  'family',
  'other',
] as const;
export type TravelPartyType = typeof TRAVEL_PARTY_TYPES[number];

export const TRAVEL_MOBILITY_REQUIREMENTS = ['low_walking', 'standard'] as const;
export type TravelMobilityRequirement = typeof TRAVEL_MOBILITY_REQUIREMENTS[number];

export interface TravelProfileSignal {
  value: number;
  confidence: number;
  source: TravelProfileSignalSource;
}

export type TravelProfileSignals = Partial<Record<TravelProfileDimensionKey, TravelProfileSignal>>;

export interface UserTravelProfileV1 {
  version: 1;
  signals: TravelProfileSignals;
  updatedAt: string;
}

export interface TripIntentV1 {
  interestKeys: TravelInterestKey[];
  pace?: 'relaxed' | 'balanced' | 'packed';
}

export interface PartyContextV1 {
  partyType?: TravelPartyType;
  hasElderly?: boolean;
  mobilityRequirement?: TravelMobilityRequirement;
}

export interface TripConstraintsV1 {
  excludedInterestKeys: TravelInterestKey[];
  lowWalking?: boolean;
}

export interface TravelProfilePatchV1 {
  signals: TravelProfileSignals;
}

export interface TripPlanningContextV1 {
  tripIntent?: TripIntentV1;
  partyContext?: PartyContextV1;
  constraints?: TripConstraintsV1;
}

export interface PlanningPolicyV1 {
  targetCorePlacesPerDay: 2 | 3;
  maxCoreAreaDistanceMeters: number;
  preferredInterestKeys: TravelInterestKey[];
  excludedInterestKeys: TravelInterestKey[];
  preferClassicLandmarks: boolean;
  preferIndoor: boolean;
  preferOutdoor: boolean;
}

export const TRAVEL_INTEREST_LABELS: Record<TravelInterestKey, readonly string[]> = {
  history: ['历史', '历史文化'],
  culture_art: ['文化', '艺术', '历史文化'],
  nature: ['自然'],
  food: ['美食'],
  coffee: ['咖啡', '咖啡店'],
  shopping: ['购物', '商场'],
  photography: ['拍照', '摄影'],
  nightlife: ['夜生活'],
  local_life: ['本地生活'],
  architecture: ['建筑'],
};

export const USER_TRAVEL_PROFILE_STORAGE_KEY = 'suixing.user-travel-profile.v1';
export const USER_TRAVEL_PROFILE_VERSION = 1 as const;
export const DEFAULT_CORE_AREA_DISTANCE_METERS = 25_000;
export const LOW_WALKING_CORE_AREA_DISTANCE_METERS = 12_000;
export const PROFILE_SIGNAL_MIN = 0;
export const PROFILE_SIGNAL_MAX = 1;

const DIMENSION_SET = new Set<string>(TRAVEL_PROFILE_DIMENSION_KEYS);
const SOURCE_SET = new Set<string>(TRAVEL_PROFILE_SIGNAL_SOURCES);
const INTEREST_SET = new Set<string>(TRAVEL_INTEREST_KEYS);
const PARTY_SET = new Set<string>(TRAVEL_PARTY_TYPES);
const MOBILITY_SET = new Set<string>(TRAVEL_MOBILITY_REQUIREMENTS);
const PACE_SET = new Set(['relaxed', 'balanced', 'packed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTravelProfileDimensionKey(value: string): value is TravelProfileDimensionKey {
  return DIMENSION_SET.has(value);
}

export function isTravelInterestKey(value: string): value is TravelInterestKey {
  return INTEREST_SET.has(value);
}

export function isTravelProfileSignalSource(value: string): value is TravelProfileSignalSource {
  return SOURCE_SET.has(value);
}

export function parseTravelProfileSignal(value: unknown): TravelProfileSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || typeof value.value !== 'number'
    || !Number.isFinite(value.value)
    || value.value < PROFILE_SIGNAL_MIN
    || value.value > PROFILE_SIGNAL_MAX
    || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || value.confidence < PROFILE_SIGNAL_MIN
    || value.confidence > PROFILE_SIGNAL_MAX
    || typeof value.source !== 'string'
    || !SOURCE_SET.has(value.source)
  ) {
    return undefined;
  }
  return {
    value: value.value,
    confidence: value.confidence,
    source: value.source as TravelProfileSignalSource,
  };
}

export function parseTravelProfileSignals(value: unknown): TravelProfileSignals | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const signals: TravelProfileSignals = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DIMENSION_SET.has(key)) {
      return undefined;
    }
    const signal = parseTravelProfileSignal(item);
    if (!signal) {
      return undefined;
    }
    signals[key as TravelProfileDimensionKey] = signal;
  }
  return signals;
}

export function cloneTravelProfileSignals(signals: TravelProfileSignals): TravelProfileSignals {
  return structuredClone(signals);
}

export function cloneUserTravelProfile(profile: UserTravelProfileV1): UserTravelProfileV1 {
  return structuredClone(profile);
}

export function emptyUserTravelProfile(updatedAt = new Date(0).toISOString()): UserTravelProfileV1 {
  return {
    version: USER_TRAVEL_PROFILE_VERSION,
    signals: {},
    updatedAt,
  };
}

export function parseInterestKeys(value: unknown): TravelInterestKey[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const keys: TravelInterestKey[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !INTEREST_SET.has(item)) {
      return undefined;
    }
    if (!keys.includes(item as TravelInterestKey)) {
      keys.push(item as TravelInterestKey);
    }
  }
  return keys;
}

export function parseTripIntentV1(value: unknown): TripIntentV1 | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const allowed = new Set(['interestKeys', 'pace']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const interestKeys = parseInterestKeys(value.interestKeys ?? []);
  if (!interestKeys) {
    return undefined;
  }
  const intent: TripIntentV1 = { interestKeys };
  if (value.pace !== undefined && value.pace !== null) {
    if (typeof value.pace !== 'string' || !PACE_SET.has(value.pace)) {
      return undefined;
    }
    intent.pace = value.pace as TripIntentV1['pace'];
  }
  return intent;
}

export function parsePartyContextV1(value: unknown): PartyContextV1 | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const allowed = new Set(['partyType', 'hasElderly', 'mobilityRequirement']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const context: PartyContextV1 = {};
  if (value.partyType !== undefined && value.partyType !== null) {
    if (typeof value.partyType !== 'string' || !PARTY_SET.has(value.partyType)) {
      return undefined;
    }
    context.partyType = value.partyType as TravelPartyType;
  }
  if (value.hasElderly !== undefined && value.hasElderly !== null) {
    if (typeof value.hasElderly !== 'boolean') {
      return undefined;
    }
    context.hasElderly = value.hasElderly;
  }
  if (value.mobilityRequirement !== undefined && value.mobilityRequirement !== null) {
    if (typeof value.mobilityRequirement !== 'string' || !MOBILITY_SET.has(value.mobilityRequirement)) {
      return undefined;
    }
    context.mobilityRequirement = value.mobilityRequirement as TravelMobilityRequirement;
  }
  return context;
}

export function parseTripConstraintsV1(value: unknown): TripConstraintsV1 | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const allowed = new Set(['excludedInterestKeys', 'lowWalking']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const excludedInterestKeys = parseInterestKeys(value.excludedInterestKeys ?? []);
  if (!excludedInterestKeys) {
    return undefined;
  }
  const constraints: TripConstraintsV1 = { excludedInterestKeys };
  if (value.lowWalking !== undefined && value.lowWalking !== null) {
    if (typeof value.lowWalking !== 'boolean') {
      return undefined;
    }
    constraints.lowWalking = value.lowWalking;
  }
  return constraints;
}

export function parseTravelProfilePatchV1(value: unknown): TravelProfilePatchV1 | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || !('signals' in value)) {
    return undefined;
  }
  const signals = parseTravelProfileSignals(value.signals);
  if (!signals) {
    return undefined;
  }
  return { signals };
}

export function parseTripPlanningContextV1(value: unknown): TripPlanningContextV1 | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const allowed = new Set(['tripIntent', 'partyContext', 'constraints']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return undefined;
  }
  const context: TripPlanningContextV1 = {};
  if ('tripIntent' in value) {
    const tripIntent = parseTripIntentV1(value.tripIntent);
    if (value.tripIntent !== null && tripIntent === undefined) {
      return undefined;
    }
    if (tripIntent) {
      context.tripIntent = tripIntent;
    }
  }
  if ('partyContext' in value) {
    const partyContext = parsePartyContextV1(value.partyContext);
    if (value.partyContext !== null && partyContext === undefined) {
      return undefined;
    }
    if (partyContext) {
      context.partyContext = partyContext;
    }
  }
  if ('constraints' in value) {
    const constraints = parseTripConstraintsV1(value.constraints);
    if (value.constraints !== null && constraints === undefined) {
      return undefined;
    }
    if (constraints) {
      context.constraints = constraints;
    }
  }
  return context;
}

export function mergeInterestKeys(
  previous: readonly TravelInterestKey[] | undefined,
  incoming: readonly TravelInterestKey[] | undefined,
): TravelInterestKey[] {
  const keys: TravelInterestKey[] = [];
  for (const key of [...(previous ?? []), ...(incoming ?? [])]) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

export function explicitProfileSignals(signals: TravelProfileSignals): TravelProfileSignals {
  const next: TravelProfileSignals = {};
  for (const key of TRAVEL_PROFILE_DIMENSION_KEYS) {
    const signal = signals[key];
    if (signal?.source === 'explicit') {
      next[key] = { ...signal };
    }
  }
  return next;
}

export function mergeProfileSignals(
  previous: TravelProfileSignals | undefined,
  incoming: TravelProfileSignals | undefined,
): TravelProfileSignals {
  const next: TravelProfileSignals = { ...(previous ? cloneTravelProfileSignals(previous) : {}) };
  if (!incoming) {
    return next;
  }
  for (const key of TRAVEL_PROFILE_DIMENSION_KEYS) {
    const signal = incoming[key];
    if (!signal) {
      continue;
    }
    const current = next[key];
    if (!current || signal.source === 'explicit' || current.source !== 'explicit') {
      next[key] = { ...signal };
    }
  }
  return next;
}

export function mergeTripIntent(
  previous: TripIntentV1 | undefined,
  incoming: TripIntentV1 | undefined,
): TripIntentV1 | undefined {
  if (!previous && !incoming) {
    return undefined;
  }
  return {
    interestKeys: mergeInterestKeys(previous?.interestKeys, incoming?.interestKeys),
    pace: incoming?.pace ?? previous?.pace,
  };
}

export function mergePartyContext(
  previous: PartyContextV1 | undefined,
  incoming: PartyContextV1 | undefined,
): PartyContextV1 | undefined {
  if (!previous && !incoming) {
    return undefined;
  }
  return {
    ...previous,
    ...incoming,
  };
}

export function mergeTripConstraints(
  previous: TripConstraintsV1 | undefined,
  incoming: TripConstraintsV1 | undefined,
): TripConstraintsV1 | undefined {
  if (!previous && !incoming) {
    return undefined;
  }
  const excludedInterestKeys = mergeInterestKeys(
    previous?.excludedInterestKeys,
    incoming?.excludedInterestKeys,
  );
  return {
    excludedInterestKeys,
    lowWalking: incoming?.lowWalking ?? previous?.lowWalking,
  };
}
