import type {
  RequirementExtractionResult,
  RequirementFieldIssue,
  TripRequirementDraft,
} from '../domain/trip/ai';
import type { TripPace, TripPreference } from '../domain/trip/types';
import {
  parsePartyContextV1,
  parseTravelProfilePatchV1,
  parseTripConstraintsV1,
  parseTripIntentV1,
} from '../domain/trip/profile';
import {
  BffClientError,
  BffHttpClient,
  DEFAULT_POST_TIMEOUT_MS,
  type FetchLike,
} from './bff-client';

export type RequirementExtractionService = {
  extractRequirements(input: string): Promise<RequirementExtractionResult>;
};

const EXTRACT_PATH = '/api/ai/requirements/extract';
const MAX_INPUT_LENGTH = 2_000;
const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const DRAFT_KEYS = new Set([
  'destination',
  'origin',
  'startDate',
  'endDate',
  'durationDays',
  'travelerCount',
  'totalBudget',
  'pace',
  'preferences',
  'tripIntent',
  'partyContext',
  'constraints',
  'profilePatch',
]);
const PREFERENCE_KEYS = new Set([
  'interests',
  'accommodation',
  'mustVisit',
  'avoid',
]);
const ISSUE_FIELDS = new Set<RequirementFieldIssue['field']>([
  'destination',
  'startDate',
  'endDate',
  'durationDays',
  'travelerCount',
  'totalBudget',
]);
const PACES = new Set<TripPace>(['relaxed', 'balanced', 'packed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    invalidResponse();
  }
  return value;
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalidResponse();
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  const number = readOptionalPositiveNumber(value);
  if (number === undefined) {
    return undefined;
  }
  if (!Number.isInteger(number)) {
    invalidResponse();
  }
  return number;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      invalidResponse();
    }
    items.push(item);
  }
  return items;
}

function readPreferences(value: unknown): TripPreference | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    invalidResponse();
  }
  for (const key of Object.keys(value)) {
    if (!PREFERENCE_KEYS.has(key)) {
      invalidResponse();
    }
  }
  if (!Array.isArray(value.interests)) {
    invalidResponse();
  }
  const preferences: TripPreference = {
    interests: readStringList(value.interests),
  };
  if (value.accommodation !== undefined) {
    preferences.accommodation = readStringList(value.accommodation);
  }
  if (value.mustVisit !== undefined) {
    preferences.mustVisit = readStringList(value.mustVisit);
  }
  if (value.avoid !== undefined) {
    preferences.avoid = readStringList(value.avoid);
  }
  return preferences;
}

function readDraft(value: unknown): TripRequirementDraft {
  if (!isRecord(value)) {
    invalidResponse();
  }
  for (const key of Object.keys(value)) {
    if (!DRAFT_KEYS.has(key)) {
      invalidResponse();
    }
  }

  const draft: TripRequirementDraft = {};
  const destination = readOptionalString(value.destination);
  const origin = readOptionalString(value.origin);
  const startDate = readOptionalString(value.startDate);
  const endDate = readOptionalString(value.endDate);
  const durationDays = readOptionalPositiveInteger(value.durationDays);
  const travelerCount = readOptionalPositiveInteger(value.travelerCount);
  const totalBudget = readOptionalPositiveNumber(value.totalBudget);
  if (value.pace !== undefined) {
    if (typeof value.pace !== 'string' || !PACES.has(value.pace as TripPace)) {
      invalidResponse();
    }
    draft.pace = value.pace as TripPace;
  }
  const preferences = readPreferences(value.preferences);
  if (destination !== undefined) draft.destination = destination;
  if (origin !== undefined) draft.origin = origin;
  if (startDate !== undefined) draft.startDate = startDate;
  if (endDate !== undefined) draft.endDate = endDate;
  if (durationDays !== undefined) draft.durationDays = durationDays;
  if (travelerCount !== undefined) draft.travelerCount = travelerCount;
  if (totalBudget !== undefined) draft.totalBudget = totalBudget;
  if (preferences !== undefined) draft.preferences = preferences;
  const tripIntent = parseTripIntentV1(value.tripIntent);
  if (value.tripIntent !== undefined && value.tripIntent !== null && !tripIntent) {
    invalidResponse();
  }
  if (tripIntent) draft.tripIntent = tripIntent;
  const partyContext = parsePartyContextV1(value.partyContext);
  if (value.partyContext !== undefined && value.partyContext !== null && !partyContext) {
    invalidResponse();
  }
  if (partyContext) draft.partyContext = partyContext;
  const constraints = parseTripConstraintsV1(value.constraints);
  if (value.constraints !== undefined && value.constraints !== null && !constraints) {
    invalidResponse();
  }
  if (constraints) draft.constraints = constraints;
  const profilePatch = parseTravelProfilePatchV1(value.profilePatch);
  if (value.profilePatch !== undefined && value.profilePatch !== null && !profilePatch) {
    invalidResponse();
  }
  if (profilePatch) draft.profilePatch = profilePatch;
  return draft;
}

function readIssues(value: unknown): RequirementFieldIssue[] {
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      invalidResponse();
    }
    const keys = Object.keys(item);
    if (
      keys.length !== 2
      || typeof item.field !== 'string'
      || !ISSUE_FIELDS.has(item.field as RequirementFieldIssue['field'])
      || typeof item.message !== 'string'
      || item.message.trim() === ''
    ) {
      invalidResponse();
    }
    return {
      field: item.field as RequirementFieldIssue['field'],
      message: item.message,
    };
  });
}

export function parseRequirementExtractionPayload(
  payload: unknown,
): RequirementExtractionResult {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    invalidResponse();
  }
  const keys = Object.keys(payload.data);
  if (
    keys.length !== 2
    || !('draft' in payload.data)
    || !('missingRequiredFields' in payload.data)
  ) {
    invalidResponse();
  }
  return {
    draft: readDraft(payload.data.draft),
    missingRequiredFields: readIssues(payload.data.missingRequiredFields),
  };
}

export class BffAiTripService implements RequirementExtractionService {
  private readonly client: BffHttpClient;

  constructor(
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs = DEFAULT_POST_TIMEOUT_MS,
  ) {
    this.client = new BffHttpClient(fetchImpl, 8_000, timeoutMs);
  }

  async extractRequirements(input: string): Promise<RequirementExtractionResult> {
    if (typeof input !== 'string' || input.trim() === '' || input.length > MAX_INPUT_LENGTH) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }

    const payload = await this.client.post(EXTRACT_PATH, { input });
    return parseRequirementExtractionPayload(payload);
  }
}
