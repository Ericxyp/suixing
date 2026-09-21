import type { RequirementFieldIssue, TripRequirementDraft } from '../domain/trip/ai';
import type { TravelInterestKey, TravelPartyType } from '../domain/trip/profile';
import { TRAVEL_INTEREST_LABELS } from '../domain/trip/profile';
import type { PlanGenerationStatus } from './plan-generation';
import { getMissingRequirementFields } from './plan-conversation-service';

export const PLAN_HERO_EYEBROW = '规划你的下一段旅程';
export const PLAN_HERO_TITLE_EMPTY = '说说你想怎么出发';
export const PLAN_EXTRACTING_STATUS = '正在整理旅行信息…';
export const PLAN_EMPTY_GUIDE = '说说你想去哪，随行会帮你一点点补齐旅行信息。';

const MISSING_LABELS: Record<RequirementFieldIssue['field'], string> = {
  destination: '目的地',
  startDate: '日期',
  endDate: '日期',
  durationDays: '日期',
  travelerCount: '人数',
  totalBudget: '预算',
};

const PARTY_LABEL: Partial<Record<TravelPartyType, string>> = {
  parents: '带父母',
  family: '家人同行',
  friends: '朋友同行',
  couple: '结伴出行',
  solo: '独自出行',
};

const INTEREST_PRIORITY_LABEL: Partial<Record<TravelInterestKey, string>> = {
  history: '历史文化优先',
  culture_art: '历史文化优先',
  nature: '自然风光优先',
  food: '美食优先',
  coffee: '咖啡店优先',
  shopping: '购物优先',
  photography: '拍照优先',
  nightlife: '夜生活优先',
  local_life: '本地生活优先',
  architecture: '建筑优先',
};

export function planHeroTitle(draft: TripRequirementDraft): string {
  const destination = draft.destination?.trim();
  if (!destination) {
    return PLAN_HERO_TITLE_EMPTY;
  }
  return `正在规划 ${destination}`;
}

export function planHeroSubtitle(draft: TripRequirementDraft): string | undefined {
  const missing = uniqueMissingLabels(getMissingRequirementFields(draft));
  if (missing.length === 0) {
    return '旅行信息已齐全，正在据此安排行程。';
  }
  if (missing.length === 1) {
    return `还差${missing[0]}`;
  }
  const head = missing.slice(0, -1).join('、');
  return `还差${head}和${missing[missing.length - 1]}`;
}

export function planHeaderStatus(input: {
  extracting: boolean;
  generationStatus: PlanGenerationStatus;
  ready: boolean;
}): string | undefined {
  if (input.extracting) {
    return '整理中';
  }
  if (input.generationStatus === 'generating') {
    return '安排中';
  }
  if (input.ready) {
    return '旅行信息';
  }
  return undefined;
}

export function planSummaryPeek(draft: TripRequirementDraft): string {
  const filled: string[] = [];
  if (draft.destination) filled.push(draft.destination);
  if (draft.startDate || draft.endDate) {
    filled.push(`${draft.startDate ?? '未定'} – ${draft.endDate ?? '未定'}`);
  } else if (draft.durationDays) {
    filled.push(`${draft.durationDays} 天`);
  }
  if (draft.travelerCount) filled.push(`${draft.travelerCount} 人`);
  const missing = uniqueMissingLabels(getMissingRequirementFields(draft));
  if (filled.length === 0 && missing.length === 0) {
    return '先补充这次旅行的基本信息';
  }
  if (missing.length === 0) {
    return filled.join(' · ');
  }
  const gap = missing.length === 1
    ? `还差${missing[0]}`
    : `还差${missing.slice(0, -1).join('、')}和${missing[missing.length - 1]}`;
  return filled.length ? `${filled.join(' · ')} · ${gap}` : gap;
}

export function tripContextChips(draft: TripRequirementDraft): string[] {
  const chips: string[] = [];
  const party = draft.partyContext;
  const lowWalking = Boolean(
    draft.constraints?.lowWalking
    || party?.mobilityRequirement === 'low_walking',
  );
  const partyLabel = party?.partyType ? PARTY_LABEL[party.partyType] : undefined;
  if (partyLabel && lowWalking) {
    chips.push(`${partyLabel} · 少走路`);
  } else if (partyLabel) {
    chips.push(partyLabel);
  } else if (lowWalking) {
    chips.push('少走路');
  }

  const intentKeys = draft.tripIntent?.interestKeys ?? [];
  const usedHistoryCulture = intentKeys.includes('history') || intentKeys.includes('culture_art');
  if (usedHistoryCulture) {
    chips.push('历史文化优先');
  }
  for (const key of intentKeys) {
    if (key === 'history' || key === 'culture_art') {
      continue;
    }
    const label = INTEREST_PRIORITY_LABEL[key];
    if (label && !chips.includes(label)) {
      chips.push(label);
    }
  }

  if (draft.tripIntent?.pace === 'relaxed') {
    chips.push('轻松节奏');
  } else if (draft.tripIntent?.pace === 'packed') {
    chips.push('紧凑节奏');
  } else if (draft.tripIntent?.pace === 'balanced') {
    chips.push('均衡节奏');
  }

  for (const key of draft.constraints?.excludedInterestKeys ?? []) {
    const noun = TRAVEL_INTEREST_LABELS[key]?.[0];
    if (noun) {
      const chip = `不安排${noun}`;
      if (!chips.includes(chip)) {
        chips.push(chip);
      }
    }
  }
  return chips;
}

function uniqueMissingLabels(issues: readonly RequirementFieldIssue[]): string[] {
  const labels: string[] = [];
  for (const issue of issues) {
    const label = MISSING_LABELS[issue.field];
    if (label && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}
