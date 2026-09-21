import type { RequirementFieldIssue, TripRequirementDraft } from '../domain/trip/ai';
import {
  parsePartyContextV1,
  parseTravelProfilePatchV1,
  parseTravelProfileSignals,
  parseTripConstraintsV1,
  parseTripIntentV1,
} from '../domain/trip/profile';
import type { PlanConversationState, PlanMessage, PlanMessageRole } from './plan-conversation-service';
import { getMissingRequirementFields } from './plan-conversation-service';

export const PLAN_CONVERSATION_STORAGE_KEY = 'suixing.plan-conversation';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const MESSAGE_ROLES = new Set<PlanMessageRole>(['user', 'assistant', 'system']);
const ISSUE_FIELDS = new Set<RequirementFieldIssue['field']>([
  'destination',
  'startDate',
  'endDate',
  'durationDays',
  'travelerCount',
  'totalBudget',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessage(value: unknown): PlanMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== 'string'
    || typeof value.content !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.role !== 'string'
    || !MESSAGE_ROLES.has(value.role as PlanMessageRole)
    || value.content.trim() === ''
  ) {
    return undefined;
  }
  return {
    id: value.id,
    role: value.role as PlanMessageRole,
    content: value.content,
    createdAt: value.createdAt,
  };
}

function readDraft(value: unknown): TripRequirementDraft {
  if (!isRecord(value)) {
    return {};
  }
  const draft: TripRequirementDraft = {};
  if (typeof value.destination === 'string') draft.destination = value.destination;
  if (typeof value.origin === 'string') draft.origin = value.origin;
  if (typeof value.startDate === 'string') draft.startDate = value.startDate;
  if (typeof value.endDate === 'string') draft.endDate = value.endDate;
  if (typeof value.durationDays === 'number') draft.durationDays = value.durationDays;
  if (typeof value.travelerCount === 'number') draft.travelerCount = value.travelerCount;
  if (typeof value.totalBudget === 'number') draft.totalBudget = value.totalBudget;
  if (value.pace === 'relaxed' || value.pace === 'balanced' || value.pace === 'packed') {
    draft.pace = value.pace;
  }
  if (isRecord(value.preferences) && Array.isArray(value.preferences.interests)) {
    draft.preferences = {
      interests: value.preferences.interests.filter((item): item is string => typeof item === 'string'),
      accommodation: Array.isArray(value.preferences.accommodation)
        ? value.preferences.accommodation.filter((item): item is string => typeof item === 'string')
        : undefined,
      mustVisit: Array.isArray(value.preferences.mustVisit)
        ? value.preferences.mustVisit.filter((item): item is string => typeof item === 'string')
        : undefined,
      avoid: Array.isArray(value.preferences.avoid)
        ? value.preferences.avoid.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  }
  const tripIntent = parseTripIntentV1(value.tripIntent);
  if (tripIntent) draft.tripIntent = tripIntent;
  const partyContext = parsePartyContextV1(value.partyContext);
  if (partyContext) draft.partyContext = partyContext;
  const constraints = parseTripConstraintsV1(value.constraints);
  if (constraints) draft.constraints = constraints;
  const profilePatch = parseTravelProfilePatchV1(value.profilePatch);
  if (profilePatch) draft.profilePatch = profilePatch;
  const longTermProfileSignals = parseTravelProfileSignals(value.longTermProfileSignals);
  if (longTermProfileSignals) draft.longTermProfileSignals = longTermProfileSignals;
  return draft;
}

function readIssues(value: unknown): RequirementFieldIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const issues: RequirementFieldIssue[] = [];
  for (const item of value) {
    if (
      !isRecord(item)
      || typeof item.field !== 'string'
      || !ISSUE_FIELDS.has(item.field as RequirementFieldIssue['field'])
      || typeof item.message !== 'string'
    ) {
      continue;
    }
    issues.push({
      field: item.field as RequirementFieldIssue['field'],
      message: item.message,
    });
  }
  return issues;
}

export function serializePlanConversation(state: PlanConversationState): string {
  return JSON.stringify({
    version: 1,
    messages: state.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
    draft: state.draft,
    missingRequiredFields: state.missingRequiredFields,
    hasShownCompletePrompt: state.hasShownCompletePrompt,
  });
}

export function deserializePlanConversation(value: string | null): PlanConversationState | null {
  if (!value) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.messages)) {
      return null;
    }
    const messages = parsed.messages
      .map(readMessage)
      .filter((message): message is PlanMessage => message !== undefined);
    const draft = readDraft(parsed.draft);
    return {
      messages,
      draft,
      missingRequiredFields: readIssues(parsed.missingRequiredFields).length
        ? readIssues(parsed.missingRequiredFields)
        : getMissingRequirementFields(draft),
      hasShownCompletePrompt: parsed.hasShownCompletePrompt === true,
    };
  } catch {
    return null;
  }
}

export function createPlanConversationStore(storage: StorageLike) {
  return {
    load(): PlanConversationState | null {
      try {
        return deserializePlanConversation(storage.getItem(PLAN_CONVERSATION_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    save(state: PlanConversationState): void {
      try {
        storage.setItem(PLAN_CONVERSATION_STORAGE_KEY, serializePlanConversation(state));
      } catch {
        // Ignore quota or unavailable storage; the in-memory page state remains.
      }
    },
    clear(): void {
      try {
        storage.removeItem(PLAN_CONVERSATION_STORAGE_KEY);
      } catch {
        // Ignore.
      }
    },
  };
}

function browserStorage(): StorageLike {
  if (typeof globalThis.sessionStorage === 'undefined') {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }
  return globalThis.sessionStorage;
}

export const planConversationStore = createPlanConversationStore(browserStorage());
