import type { Place, Trip } from '../../src/domain/trip/types';
import {
  parseApplyTripPlaces,
  TRIP_CHANGE_APPLY_MAX_BODY_CHARS,
} from './trip-change-apply-request';
import type { SelectMealPlaceOperation } from './trip-change-executor';

const BODY_KEYS = new Set(['trip', 'places', 'operation']);
const OPERATION_KEYS = new Set(['type', 'dayNumber', 'mealSlotId', 'placeId']);
const FORBIDDEN = new Set(['key', 'jscode', 'sig', 'url', 'prompt', 'schema', 'model', 'apiKey', 'baseUrl']);
const ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;

export interface TripMealApplySnapshot {
  trip: Trip;
  places: Place[];
  operation: SelectMealPlaceOperation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsForbidden(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbidden(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => FORBIDDEN.has(key) || containsForbidden(value[key]));
}

function readOperation(value: unknown, trip: Trip): SelectMealPlaceOperation | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !OPERATION_KEYS.has(key))) {
    return undefined;
  }
  if (
    value.type !== 'SELECT_MEAL_PLACE'
    || typeof value.dayNumber !== 'number'
    || !Number.isInteger(value.dayNumber)
    || typeof value.mealSlotId !== 'string'
    || !ID_PATTERN.test(value.mealSlotId)
    || typeof value.placeId !== 'string'
    || !ID_PATTERN.test(value.placeId)
  ) {
    return undefined;
  }
  const day = trip.days.find((item) => item.dayNumber === value.dayNumber);
  const slot = day?.scheduleItems?.find((item) => item.kind === 'meal_slot' && item.id === value.mealSlotId);
  if (!slot || slot.kind !== 'meal_slot' || slot.diningMode !== 'flexible') {
    return undefined;
  }
  return {
    type: 'SELECT_MEAL_PLACE',
    dayNumber: value.dayNumber,
    mealSlotId: value.mealSlotId,
    placeId: value.placeId,
  };
}

export function parseTripMealApplyBody(body: unknown): TripMealApplySnapshot | undefined {
  try {
    if (JSON.stringify(body).length > TRIP_CHANGE_APPLY_MAX_BODY_CHARS) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (!isRecord(body) || containsForbidden(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    return undefined;
  }
  if (Object.keys(body).length !== 3) {
    return undefined;
  }
  const snapshot = parseApplyTripPlaces(body);
  if (!snapshot) {
    return undefined;
  }
  const operation = readOperation(body.operation, snapshot.trip);
  if (!operation) {
    return undefined;
  }
  return { trip: snapshot.trip, places: snapshot.places, operation };
}
