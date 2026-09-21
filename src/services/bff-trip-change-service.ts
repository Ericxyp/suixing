import type { Place, Trip, TripPlaceType } from '../domain/trip/types';
import {
  BffClientError,
  BffHttpClient,
  DEFAULT_POST_TIMEOUT_MS,
  TRIP_CHANGE_APPLY_TIMEOUT_MS,
  type FetchLike,
} from './bff-client';
import { parseInternalPlaces, parseInternalTrip } from './bff-trip-generation-service';

export const TRIP_CHANGE_INTERPRET_PATH = '/api/ai/trips/change/interpret';
export const TRIP_CHANGE_APPLY_PATH = '/api/trips/change/apply';
export const TRIP_CHANGE_INTERPRET_TIMEOUT_MS = DEFAULT_POST_TIMEOUT_MS;
export const TRIP_CHANGE_MAX_INPUT_LENGTH = 1_000;

const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface TripChangeContextStop {
  tripPlaceId: string;
  placeName: string;
  type: TripPlaceType;
  startTime: string;
}

export interface TripChangeContextDay {
  dayNumber: number;
  stops: TripChangeContextStop[];
}

export interface TripChangeContext {
  tripId: string;
  destination: string;
  days: TripChangeContextDay[];
}

export type ReplacePlaceOperation = {
  type: 'REPLACE_PLACE';
  dayNumber: number;
  targetTripPlaceId: string;
  replacementQuery: string;
};

export interface TripChangeCandidate {
  placeId: string;
  name: string;
  categoryLabel: string;
  relation: string;
}

export interface TripChangeSourceChoice {
  tripPlaceId: string;
  placeName: string;
}

export interface TripChangePendingReplace {
  dayNumber: number;
  targetTripPlaceId: string;
}

export interface TripChangeFocus {
  selectedDayNumber?: number;
  sourceTripPlaceId?: string;
}

export interface TripChangeIntent {
  status: 'ready' | 'needs_clarification' | 'needs_choice';
  summary: string;
  operations: ReplacePlaceOperation[];
  candidates?: TripChangeCandidate[];
  sourceChoices?: TripChangeSourceChoice[];
  pendingReplace?: TripChangePendingReplace;
}

export interface ReplacePlaceSummary {
  type: 'REPLACE_PLACE';
  dayNumber: number;
  replacedTripPlaceId: string;
  previousPlaceName: string;
  nextPlaceName: string;
  routeRecalculated: boolean;
}

export interface TripChangeApplyResult {
  trip: Trip;
  places: Place[];
  summary: ReplacePlaceSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
}

export function buildTripChangeContext(trip: Trip): TripChangeContext {
  return {
    tripId: trip.id,
    destination: trip.destination,
    days: trip.days.map((day) => ({
      dayNumber: day.dayNumber,
      stops: [...day.places]
        .sort((left, right) => left.order - right.order)
        .map((place) => ({
          tripPlaceId: place.id,
          placeName: place.placeName,
          type: place.type,
          startTime: place.startTime && CLOCK_TIME.test(place.startTime) ? place.startTime : '10:00',
        })),
    })),
  };
}

export function isReadyReplaceIntent(intent: TripChangeIntent): intent is TripChangeIntent & {
  operations: [ReplacePlaceOperation];
} {
  return (
    intent.status === 'ready'
    && intent.operations.length === 1
    && intent.operations[0]?.type === 'REPLACE_PLACE'
  );
}

function readReplaceOperation(value: unknown): ReplacePlaceOperation {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4
    || value.type !== 'REPLACE_PLACE'
    || typeof value.dayNumber !== 'number'
    || !Number.isInteger(value.dayNumber)
    || typeof value.targetTripPlaceId !== 'string'
    || value.targetTripPlaceId.trim() === ''
    || typeof value.replacementQuery !== 'string'
    || value.replacementQuery.trim() === ''
    || value.replacementQuery.length > 80
  ) {
    invalidResponse();
  }
  return {
    type: 'REPLACE_PLACE',
    dayNumber: value.dayNumber,
    targetTripPlaceId: value.targetTripPlaceId,
    replacementQuery: value.replacementQuery.trim(),
  };
}

const INTENT_PUBLIC_KEYS = new Set([
  'status',
  'summary',
  'operations',
  'candidates',
  'sourceChoices',
  'pendingReplace',
]);

function readCandidate(value: unknown): TripChangeCandidate {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4
    || typeof value.placeId !== 'string'
    || value.placeId.trim() === ''
    || typeof value.name !== 'string'
    || value.name.trim() === ''
    || typeof value.categoryLabel !== 'string'
    || value.categoryLabel.trim() === ''
    || typeof value.relation !== 'string'
    || value.relation.trim() === ''
  ) {
    invalidResponse();
  }
  return {
    placeId: value.placeId.trim(),
    name: value.name.trim(),
    categoryLabel: value.categoryLabel.trim(),
    relation: value.relation.trim(),
  };
}

function readSourceChoice(value: unknown): TripChangeSourceChoice {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || typeof value.tripPlaceId !== 'string'
    || value.tripPlaceId.trim() === ''
    || typeof value.placeName !== 'string'
    || value.placeName.trim() === ''
  ) {
    invalidResponse();
  }
  return {
    tripPlaceId: value.tripPlaceId.trim(),
    placeName: value.placeName.trim(),
  };
}

function readPendingReplace(value: unknown): TripChangePendingReplace {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || typeof value.dayNumber !== 'number'
    || !Number.isInteger(value.dayNumber)
    || typeof value.targetTripPlaceId !== 'string'
    || value.targetTripPlaceId.trim() === ''
  ) {
    invalidResponse();
  }
  return {
    dayNumber: value.dayNumber,
    targetTripPlaceId: value.targetTripPlaceId.trim(),
  };
}

export function parseTripChangeIntentPayload(payload: unknown): TripChangeIntent {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.intent)) {
    invalidResponse();
  }
  const keys = Object.keys(payload.data);
  if (keys.length !== 1 || !('intent' in payload.data)) {
    invalidResponse();
  }
  const intent = payload.data.intent;
  const intentKeys = Object.keys(intent);
  if (
    intentKeys.some((key) => !INTENT_PUBLIC_KEYS.has(key))
    || !('status' in intent)
    || !('summary' in intent)
    || !('operations' in intent)
    || (
      intent.status !== 'ready'
      && intent.status !== 'needs_clarification'
      && intent.status !== 'needs_choice'
    )
    || typeof intent.summary !== 'string'
    || intent.summary.trim() === ''
    || intent.summary.length > 120
    || !Array.isArray(intent.operations)
  ) {
    invalidResponse();
  }
  if (intent.status === 'needs_clarification') {
    if (intent.operations.length !== 0) {
      invalidResponse();
    }
    return {
      status: 'needs_clarification',
      summary: intent.summary.trim(),
      operations: [],
      ...(Array.isArray(intent.sourceChoices)
        ? { sourceChoices: intent.sourceChoices.map(readSourceChoice) }
        : {}),
    };
  }
  if (intent.status === 'needs_choice') {
    if (intent.operations.length !== 0) {
      invalidResponse();
    }
    const candidates = Array.isArray(intent.candidates)
      ? intent.candidates.map(readCandidate)
      : [];
    if (candidates.length < 1 || candidates.length > 5) {
      invalidResponse();
    }
    return {
      status: 'needs_choice',
      summary: intent.summary.trim(),
      operations: [],
      candidates,
      ...(intent.pendingReplace ? { pendingReplace: readPendingReplace(intent.pendingReplace) } : {}),
    };
  }
  if (intent.operations.length !== 1) {
    invalidResponse();
  }
  return {
    status: 'ready',
    summary: intent.summary.trim(),
    operations: [readReplaceOperation(intent.operations[0])],
  };
}

function readSummary(value: unknown): ReplacePlaceSummary {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 6
    || value.type !== 'REPLACE_PLACE'
    || typeof value.dayNumber !== 'number'
    || !Number.isInteger(value.dayNumber)
    || typeof value.replacedTripPlaceId !== 'string'
    || typeof value.previousPlaceName !== 'string'
    || value.previousPlaceName.trim() === ''
    || typeof value.nextPlaceName !== 'string'
    || value.nextPlaceName.trim() === ''
    || typeof value.routeRecalculated !== 'boolean'
    || 'replacementQuery' in value
  ) {
    invalidResponse();
  }
  return {
    type: 'REPLACE_PLACE',
    dayNumber: value.dayNumber,
    replacedTripPlaceId: value.replacedTripPlaceId,
    previousPlaceName: value.previousPlaceName,
    nextPlaceName: value.nextPlaceName,
    routeRecalculated: value.routeRecalculated,
  };
}

export function parseTripChangeApplyPayload(payload: unknown): TripChangeApplyResult {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    invalidResponse();
  }
  const keys = Object.keys(payload.data);
  if (
    keys.length !== 3
    || !('trip' in payload.data)
    || !('places' in payload.data)
    || !('summary' in payload.data)
  ) {
    invalidResponse();
  }
  const trip = parseInternalTrip(payload.data.trip);
  return {
    trip,
    places: parseInternalPlaces(payload.data.places, trip),
    summary: readSummary(payload.data.summary),
  };
}

export interface TripChangeInterpretService {
  interpret(input: string, trip: Trip, focus?: TripChangeFocus): Promise<TripChangeIntent>;
}

export interface TripChangeApplyService {
  apply(input: {
    trip: Trip;
    places: Place[];
    operation: ReplacePlaceOperation;
    expectedTripId: string;
  }): Promise<TripChangeApplyResult>;
}

export class BffTripChangeService implements TripChangeInterpretService, TripChangeApplyService {
  private readonly client: BffHttpClient;

  constructor(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.client = new BffHttpClient(fetchImpl, 8_000, TRIP_CHANGE_INTERPRET_TIMEOUT_MS);
  }

  async interpret(input: string, trip: Trip, focus?: TripChangeFocus): Promise<TripChangeIntent> {
    if (typeof input !== 'string' || input.trim() === '' || input.length > TRIP_CHANGE_MAX_INPUT_LENGTH) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const payload = await this.client.post(TRIP_CHANGE_INTERPRET_PATH, {
      input: input.trim(),
      context: buildTripChangeContext(trip),
      ...(focus && (focus.selectedDayNumber || focus.sourceTripPlaceId)
        ? { focus }
        : {}),
    }, TRIP_CHANGE_INTERPRET_TIMEOUT_MS);
    return parseTripChangeIntentPayload(payload);
  }

  async apply(input: {
    trip: Trip;
    places: Place[];
    operation: ReplacePlaceOperation;
    expectedTripId: string;
  }): Promise<TripChangeApplyResult> {
    if (input.trip.id !== input.expectedTripId) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const operation = input.operation;
    const day = input.trip.days.find((item) => item.dayNumber === operation.dayNumber);
    if (!day || !day.places.some((place) => place.id === operation.targetTripPlaceId)) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const payload = await this.client.post(TRIP_CHANGE_APPLY_PATH, {
      trip: structuredClone(input.trip),
      places: structuredClone(input.places),
      operation: {
        type: 'REPLACE_PLACE',
        dayNumber: operation.dayNumber,
        targetTripPlaceId: operation.targetTripPlaceId,
        replacementQuery: operation.replacementQuery,
      },
    }, TRIP_CHANGE_APPLY_TIMEOUT_MS);
    return parseTripChangeApplyPayload(payload);
  }
}
