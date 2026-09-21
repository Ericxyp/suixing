import type { TripRequirementDraft } from '../domain/trip/ai';
import type {
  TravelInterestKey,
  TravelPartyType,
  TravelProfileSignals,
} from '../domain/trip/profile';
import { TRAVEL_INTEREST_KEYS } from '../domain/trip/profile';
import type { TripPace } from '../domain/trip/types';
import { getMissingRequirementFields } from './plan-conversation-service';

export const TRIP_STYLE_CARD_TITLE = '本次旅行风格';
export const TRIP_STYLE_EMPTY_COPY = '将按均衡节奏安排，可随时补充偏好。';
export const TRIP_STYLE_FOOTNOTE = '本次偏好会优先于长期习惯，用于安排景点密度、区域距离和休息节奏。';
export const TRIP_STYLE_EDIT_LABEL = '调整本次偏好';

export const TRIP_STYLE_INTEREST_LABELS: Record<TravelInterestKey, string> = {
  history: '历史文化',
  culture_art: '文化艺术',
  nature: '自然风景',
  food: '美食',
  coffee: '咖啡休息',
  photography: '拍照',
  architecture: '建筑',
  local_life: '本地生活',
  nightlife: '夜间体验',
  shopping: '购物',
};

export const TRIP_STYLE_PARTY_LABELS: Partial<Record<TravelPartyType, string>> = {
  parents: '带父母同行',
  family: '家庭出行',
  couple: '双人同行',
  friends: '朋友同行',
  solo: '独自出行',
};

export const TRIP_STYLE_PACE_LABELS: Record<TripPace, string> = {
  relaxed: '轻松节奏',
  balanced: '均衡节奏',
  packed: '紧凑节奏',
};

export interface TripStyleViewV1 {
  visible: boolean;
  empty: boolean;
  interestLabels: string[];
  companionLabels: string[];
  paceLabel: string;
  avoidLabels: string[];
  longTermHint?: string;
}

function uniqueKeys(keys: readonly TravelInterestKey[]): TravelInterestKey[] {
  return keys.filter((key, index) => keys.indexOf(key) === index);
}

export function tripStyleInterestLabels(keys: readonly TravelInterestKey[]): string[] {
  return uniqueKeys(keys).slice(0, 3).map((key) => TRIP_STYLE_INTEREST_LABELS[key]);
}

export function tripStyleAvoidLabel(key: TravelInterestKey): string {
  if (key === 'shopping') {
    return '不安排购物';
  }
  if (key === 'nightlife') {
    return '尽量避开夜间体验';
  }
  return `尽量避开${TRIP_STYLE_INTEREST_LABELS[key]}`;
}

function companionLabels(draft: TripRequirementDraft): string[] {
  const labels: string[] = [];
  const party = draft.partyContext;
  const partyLabel = party?.partyType ? TRIP_STYLE_PARTY_LABELS[party.partyType] : undefined;
  if (partyLabel) {
    labels.push(partyLabel);
  }
  if (party?.hasElderly) {
    labels.push('有长辈同行');
  }
  const lowWalking = Boolean(
    draft.constraints?.lowWalking
    || party?.mobilityRequirement === 'low_walking',
  );
  if (lowWalking) {
    labels.push('少走路');
  }
  return labels;
}

function paceLabel(draft: TripRequirementDraft): string {
  const pace = draft.tripIntent?.pace ?? draft.pace ?? 'balanced';
  return TRIP_STYLE_PACE_LABELS[pace];
}

function avoidLabels(draft: TripRequirementDraft): string[] {
  return uniqueKeys(draft.constraints?.excludedInterestKeys ?? []).slice(0, 2).map(tripStyleAvoidLabel);
}

function longTermHint(draft: TripRequirementDraft): string | undefined {
  const signals: TravelProfileSignals = draft.longTermProfileSignals ?? {};
  const covered = new Set([
    ...(draft.tripIntent?.interestKeys ?? []),
    ...(draft.constraints?.excludedInterestKeys ?? []),
  ]);
  const labels: string[] = [];
  for (const key of TRAVEL_INTEREST_KEYS) {
    if (labels.length >= 2) {
      break;
    }
    const signal = signals[key];
    if (
      !signal
      || signal.source !== 'explicit'
      || typeof signal.value !== 'number'
      || !Number.isFinite(signal.value)
      || signal.value < 0.6
    ) {
      continue;
    }
    if (covered.has(key)) {
      continue;
    }
    labels.push(TRIP_STYLE_INTEREST_LABELS[key]);
  }
  if (labels.length === 0) {
    return undefined;
  }
  return `你常关注：${labels.join('、')}`;
}

export function hasTripStyleFacts(draft: TripRequirementDraft): boolean {
  return Boolean(
    (draft.tripIntent?.interestKeys?.length ?? 0) > 0
    || draft.tripIntent?.pace
    || draft.pace
    || draft.partyContext?.partyType
    || draft.partyContext?.hasElderly
    || draft.partyContext?.mobilityRequirement === 'low_walking'
    || draft.constraints?.lowWalking
    || (draft.constraints?.excludedInterestKeys?.length ?? 0) > 0,
  );
}

export function buildTripStyleViewV1(draft: TripRequirementDraft): TripStyleViewV1 {
  const excluded = new Set(draft.constraints?.excludedInterestKeys ?? []);
  const interestKeys = (draft.tripIntent?.interestKeys ?? []).filter((key) => !excluded.has(key));
  const interests = tripStyleInterestLabels(interestKeys);
  const companions = companionLabels(draft);
  const pace = paceLabel(draft);
  const avoids = avoidLabels(draft);
  const hint = longTermHint(draft);
  const hasFacts = hasTripStyleFacts(draft);
  const ready = getMissingRequirementFields(draft).length === 0 && Boolean(draft.destination);
  const empty = !hasFacts;
  return {
    visible: hasFacts || ready || Boolean(hint),
    empty,
    interestLabels: empty ? [] : interests,
    companionLabels: empty ? [] : companions,
    paceLabel: empty ? TRIP_STYLE_PACE_LABELS.balanced : pace,
    avoidLabels: empty ? [] : avoids,
    longTermHint: hint,
  };
}

export function tripStyleEditorState(draft: TripRequirementDraft): {
  interestKeys: TravelInterestKey[];
  pace: TripPace;
  partyType?: TravelPartyType;
  lowWalking: boolean;
  excludedInterestKeys: TravelInterestKey[];
} {
  return {
    interestKeys: uniqueKeys(draft.tripIntent?.interestKeys ?? []).slice(0, 3),
    pace: draft.tripIntent?.pace ?? draft.pace ?? 'balanced',
    partyType: draft.partyContext?.partyType,
    lowWalking: Boolean(
      draft.constraints?.lowWalking
      || draft.partyContext?.mobilityRequirement === 'low_walking',
    ),
    excludedInterestKeys: uniqueKeys(draft.constraints?.excludedInterestKeys ?? []).slice(0, 2),
  };
}

export function applyTripStyleToRequirementDraft(
  draft: TripRequirementDraft,
  style: {
    interestKeys: readonly TravelInterestKey[];
    pace: TripPace;
    partyType?: TravelPartyType;
    lowWalking: boolean;
    excludedInterestKeys: readonly TravelInterestKey[];
  },
): TripRequirementDraft {
  const excluded = uniqueKeys(style.excludedInterestKeys).slice(0, 2);
  const interests = uniqueKeys(style.interestKeys)
    .filter((key) => !excluded.includes(key))
    .slice(0, 3);
  const next: TripRequirementDraft = {
    ...draft,
    pace: style.pace,
    tripIntent: {
      interestKeys: interests,
      pace: style.pace,
    },
    partyContext: undefined,
    constraints: {
      excludedInterestKeys: excluded,
      lowWalking: style.lowWalking,
    },
  };
  if (style.partyType || draft.partyContext?.hasElderly || style.lowWalking) {
    next.partyContext = {
      ...(style.partyType ? { partyType: style.partyType } : {}),
      ...(draft.partyContext?.hasElderly ? { hasElderly: true } : {}),
      ...(style.lowWalking ? { mobilityRequirement: 'low_walking' as const } : {}),
    };
  }
  return next;
}
