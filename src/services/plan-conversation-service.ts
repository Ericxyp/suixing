import type {
  RequirementExtractionResult,
  RequirementFieldIssue,
  TripRequirementDraft,
} from '../domain/trip/ai';
import type { TripPace, TripPreference } from '../domain/trip/types';
import type { CreateTripInput } from '../repositories/trip-repository';
import { BffClientError } from './bff-client';
import type { RequirementExtractionService } from './trip-requirement-service';

export const PLAN_CONVERSATION_PATH = '/plan/new';
export const PLAN_GENERATING_MESSAGE = '旅行信息已齐全，正在为你安排行程…';
export const PLAN_COMPLETE_MESSAGE = PLAN_GENERATING_MESSAGE;
export const PLAN_GENERATION_FAILED_MESSAGE = '暂时没能完善这份行程。你可以补充偏好，或稍后重试。';
export const DESTINATION_QUESTION = '你想去哪个城市或地区旅行？';
export const SCHEDULE_QUESTION = '计划什么时候出发、玩几天？';
export const TRAVELER_QUESTION = '这次一共几位出行？';
export const BUDGET_QUESTION = '这次旅行的总预算大约是多少？';
export const MAX_EXTRACTION_INPUT_LENGTH = 2_000;

export type PlanMessageRole = 'user' | 'assistant' | 'system';

export interface PlanMessage {
  id: string;
  role: PlanMessageRole;
  content: string;
  createdAt: string;
}

export interface PlanConversationState {
  messages: PlanMessage[];
  draft: TripRequirementDraft;
  missingRequiredFields: RequirementFieldIssue[];
  hasShownCompletePrompt: boolean;
}

export interface PlanLocationState {
  initialText?: string;
}

let messageSequence = 0;

export function createEmptyPlanConversation(): PlanConversationState {
  return {
    messages: [],
    draft: {},
    missingRequiredFields: [],
    hasShownCompletePrompt: false,
  };
}

export function parseHomeTripRequest(request: string):
  | { ok: false; notice: string }
  | { ok: true; path: string; state: PlanLocationState } {
  const initialText = request.trim();
  if (!initialText) {
    return { ok: false, notice: '先说说你想去哪里。' };
  }
  return {
    ok: true,
    path: PLAN_CONVERSATION_PATH,
    state: { initialText },
  };
}

export function noticeForRequirementExtractionError(error: unknown): string {
  if (
    error instanceof BffClientError
    && (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'AI_PROVIDER_UNAVAILABLE')
  ) {
    return '智能服务尚未配置，请稍后再试。';
  }
  return '暂时无法整理旅行需求，请重试。';
}

export function getMissingRequirementFields(
  draft: TripRequirementDraft,
): RequirementFieldIssue[] {
  const hasDateRange = Boolean(
    draft.startDate
    && draft.endDate
    && draft.endDate >= draft.startDate,
  );
  const missing: RequirementFieldIssue[] = [];
  if (!draft.destination) {
    missing.push({ field: 'destination', message: '请补充目的地。' });
  }
  if (!draft.durationDays && !hasDateRange) {
    missing.push({ field: 'durationDays', message: '请补充日期或行程天数。' });
  }
  if (!draft.travelerCount) {
    missing.push({ field: 'travelerCount', message: '请补充同行人数。' });
  }
  if (!draft.totalBudget) {
    missing.push({ field: 'totalBudget', message: '请补充总预算。' });
  }
  return missing;
}

export function nextFollowUpQuestion(
  missingRequiredFields: readonly RequirementFieldIssue[],
): string | undefined {
  const fields = new Set(missingRequiredFields.map((issue) => issue.field));
  if (fields.has('destination')) {
    return DESTINATION_QUESTION;
  }
  if (fields.has('durationDays') || fields.has('startDate') || fields.has('endDate')) {
    return SCHEDULE_QUESTION;
  }
  if (fields.has('travelerCount')) {
    return TRAVELER_QUESTION;
  }
  if (fields.has('totalBudget')) {
    return BUDGET_QUESTION;
  }
  return undefined;
}

export function userUtterances(messages: readonly PlanMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean);
}

export function buildExtractionInput(messages: readonly PlanMessage[]): string {
  const lines = userUtterances(messages);
  if (lines.length === 0) {
    return '';
  }
  let text = lines.join('\n');
  while (text.length > MAX_EXTRACTION_INPUT_LENGTH && lines.length > 1) {
    lines.shift();
    text = lines.join('\n');
  }
  if (text.length > MAX_EXTRACTION_INPUT_LENGTH) {
    return text.slice(text.length - MAX_EXTRACTION_INPUT_LENGTH);
  }
  return text;
}

function uniqueStrings(values: string[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (text !== '' && !items.includes(text)) {
      items.push(text);
    }
  }
  return items;
}

function mergePreferences(
  previous?: TripPreference,
  incoming?: TripPreference,
): TripPreference | undefined {
  if (!previous && !incoming) {
    return undefined;
  }
  const interests = uniqueStrings([
    ...(previous?.interests ?? []),
    ...(incoming?.interests ?? []),
  ]);
  const accommodation = uniqueStrings([
    ...(previous?.accommodation ?? []),
    ...(incoming?.accommodation ?? []),
  ]);
  const mustVisit = uniqueStrings([
    ...(previous?.mustVisit ?? []),
    ...(incoming?.mustVisit ?? []),
  ]);
  const avoid = uniqueStrings([
    ...(previous?.avoid ?? []),
    ...(incoming?.avoid ?? []),
  ]);
  const preferences: TripPreference = { interests };
  if (accommodation.length) preferences.accommodation = accommodation;
  if (mustVisit.length) preferences.mustVisit = mustVisit;
  if (avoid.length) preferences.avoid = avoid;
  return preferences;
}

export function mergeRequirementDrafts(
  previous: TripRequirementDraft,
  incoming: TripRequirementDraft,
): TripRequirementDraft {
  const merged: TripRequirementDraft = {
    destination: incoming.destination ?? previous.destination,
    origin: incoming.origin ?? previous.origin,
    startDate: incoming.startDate ?? previous.startDate,
    endDate: incoming.endDate ?? previous.endDate,
    durationDays: incoming.durationDays ?? previous.durationDays,
    travelerCount: incoming.travelerCount ?? previous.travelerCount,
    totalBudget: incoming.totalBudget ?? previous.totalBudget,
    pace: incoming.pace ?? previous.pace,
    preferences: mergePreferences(previous.preferences, incoming.preferences),
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as TripRequirementDraft;
}

export function createPlanMessage(
  role: PlanMessageRole,
  content: string,
  now = Date.now(),
): PlanMessage {
  messageSequence += 1;
  return {
    id: `plan-${now}-${messageSequence}`,
    role,
    content,
    createdAt: new Date(now).toISOString(),
  };
}

export function appendUserMessage(
  state: PlanConversationState,
  content: string,
  now = Date.now(),
): PlanConversationState {
  const text = content.trim();
  if (!text) {
    return state;
  }
  return {
    ...state,
    messages: [...state.messages, createPlanMessage('user', text, now)],
  };
}

function lastAssistantContent(messages: readonly PlanMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return messages[index].content;
    }
  }
  return undefined;
}

export function applyAssistantGuidance(
  state: PlanConversationState,
  now = Date.now(),
): PlanConversationState {
  const question = nextFollowUpQuestion(state.missingRequiredFields);
  const messages = [...state.messages];
  let hasShownCompletePrompt = state.hasShownCompletePrompt;
  if (question) {
    hasShownCompletePrompt = false;
    if (lastAssistantContent(messages) !== question) {
      messages.push(createPlanMessage('assistant', question, now));
    }
  } else if (!hasShownCompletePrompt) {
    messages.push(createPlanMessage('assistant', PLAN_GENERATING_MESSAGE, now));
    hasShownCompletePrompt = true;
  }
  return {
    ...state,
    messages,
    hasShownCompletePrompt,
  };
}

function resetCompletePromptIfDraftChanged(
  previous: TripRequirementDraft,
  next: TripRequirementDraft,
  hasShownCompletePrompt: boolean,
): boolean {
  const previousKey = JSON.stringify(previous);
  const nextKey = JSON.stringify(next);
  return previousKey === nextKey ? hasShownCompletePrompt : false;
}

export function applyExtractionResult(
  state: PlanConversationState,
  result: RequirementExtractionResult,
  now = Date.now(),
): PlanConversationState {
  const draft = mergeRequirementDrafts(state.draft, result.draft);
  return applyAssistantGuidance({
    ...state,
    draft,
    missingRequiredFields: getMissingRequirementFields(draft),
    hasShownCompletePrompt: resetCompletePromptIfDraftChanged(
      state.draft,
      draft,
      state.hasShownCompletePrompt,
    ),
  }, now);
}

export function formatSummaryEditIntent(
  field: keyof TripRequirementDraft | 'preferences',
  draft: TripRequirementDraft,
): string {
  if (field === 'destination') {
    return `将目的地调整为${draft.destination ?? '未定'}`;
  }
  if (field === 'origin') {
    return `将出发地调整为${draft.origin ?? '未定'}`;
  }
  if (field === 'startDate' || field === 'endDate') {
    if (draft.startDate && draft.endDate) {
      return `将出行日期调整为 ${draft.startDate} 至 ${draft.endDate}`;
    }
    if (draft.startDate) {
      return `将出发日期调整为 ${draft.startDate}`;
    }
    return `将结束日期调整为 ${draft.endDate ?? '未定'}`;
  }
  if (field === 'durationDays') {
    return `将行程天数调整为 ${draft.durationDays ?? '未定'} 天`;
  }
  if (field === 'travelerCount') {
    return `将出行人数调整为 ${draft.travelerCount ?? '未定'} 人`;
  }
  if (field === 'totalBudget') {
    const budget = draft.totalBudget
      ? `¥${draft.totalBudget.toLocaleString('zh-CN')}`
      : '未定';
    return `将总预算调整为 ${budget}`;
  }
  if (field === 'pace') {
    const labels: Record<TripPace, string> = {
      relaxed: '轻松',
      balanced: '均衡',
      packed: '紧凑',
    };
    return `将行程节奏调整为${draft.pace ? labels[draft.pace] : '未定'}`;
  }
  const interests = draft.preferences?.interests?.join('、') || '未定';
  return `将兴趣偏好调整为${interests}`;
}

export function applySummaryDraftUpdate(
  state: PlanConversationState,
  draft: TripRequirementDraft,
  intentMessage: string,
  now = Date.now(),
): PlanConversationState {
  const withIntent = appendUserMessage(state, intentMessage, now);
  return applyAssistantGuidance({
    ...withIntent,
    draft,
    missingRequiredFields: getMissingRequirementFields(draft),
    hasShownCompletePrompt: resetCompletePromptIfDraftChanged(
      state.draft,
      draft,
      state.hasShownCompletePrompt,
    ),
  }, now);
}

function replaceLastMatchingAssistant(
  messages: PlanMessage[],
  fromContent: string,
  toContent: string,
  now: number,
): PlanMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role === 'assistant' && next[index].content === fromContent) {
      next[index] = { ...next[index], content: toContent };
      return next;
    }
  }
  if (!next.some((message) => message.content === toContent)) {
    next.push(createPlanMessage('assistant', toContent, now));
  }
  return next;
}

export function applyGenerationStarted(
  state: PlanConversationState,
  now = Date.now(),
): PlanConversationState {
  return {
    ...state,
    messages: replaceLastMatchingAssistant(
      state.messages,
      PLAN_GENERATION_FAILED_MESSAGE,
      PLAN_GENERATING_MESSAGE,
      now,
    ),
  };
}

export function applyGenerationFailure(
  state: PlanConversationState,
  now = Date.now(),
): PlanConversationState {
  return {
    ...state,
    messages: replaceLastMatchingAssistant(
      state.messages,
      PLAN_GENERATING_MESSAGE,
      PLAN_GENERATION_FAILED_MESSAGE,
      now,
    ),
  };
}

export async function extractPlanRequirements(
  state: PlanConversationState,
  service: RequirementExtractionService,
): Promise<RequirementExtractionResult> {
  const input = buildExtractionInput(state.messages);
  return service.extractRequirements(input);
}

export function isPlanReadyToGenerate(draft: TripRequirementDraft): boolean {
  return getMissingRequirementFields(draft).length === 0 && Boolean(draft.destination);
}

export function toCreateTripRequirements(
  draft: TripRequirementDraft,
): CreateTripInput['requirements'] | undefined {
  if (!isPlanReadyToGenerate(draft) || !draft.destination || !draft.travelerCount || !draft.totalBudget) {
    return undefined;
  }
  return {
    ...draft,
    destination: draft.destination.trim(),
    travelerCount: draft.travelerCount,
    totalBudget: draft.totalBudget,
    pace: draft.pace ?? 'balanced',
  };
}
