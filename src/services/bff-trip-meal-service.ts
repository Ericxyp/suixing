import type { Place, Trip, TripMealPeriod, TripPlaceType } from '../domain/trip/types';
import {
  BffClientError,
  BffHttpClient,
  TRIP_CHANGE_APPLY_TIMEOUT_MS,
  type FetchLike,
} from './bff-client';
import { parseInternalPlaces, parseInternalTrip } from './bff-trip-generation-service';

export const TRIP_MEAL_OPTIONS_PATH = '/api/trips/meal-options';
export const TRIP_MEAL_APPLY_PATH = '/api/trips/meal/apply';

const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const PLACE_TYPES = new Set<TripPlaceType>([
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
]);

export type MealOptionsCategory = 'local' | 'quick' | 'coffee';

export interface MealOptionsRequest {
  city: string;
  mealPeriod: TripMealPeriod;
  area: {
    placeId: string;
    name: string;
    longitude: number;
    latitude: number;
  };
  nextPlace?: {
    placeId: string;
    name: string;
    longitude: number;
    latitude: number;
  };
  category?: MealOptionsCategory;
}

export interface SelectMealPlaceSummary {
  type: 'SELECT_MEAL_PLACE';
  dayNumber: number;
  mealSlotId: string;
  nextPlaceName: string;
  routeRecalculated: boolean;
}

export interface TripMealApplyResult {
  trip: Trip;
  places: Place[];
  summary: SelectMealPlaceSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
}

function readPlace(value: unknown): Place {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 8
    || typeof value.id !== 'string'
    || (value.provider !== 'amap' && value.provider !== 'mock')
    || typeof value.providerPlaceId !== 'string'
    || typeof value.name !== 'string'
    || typeof value.address !== 'string'
    || typeof value.latitude !== 'number'
    || typeof value.longitude !== 'number'
    || typeof value.category !== 'string'
    || !PLACE_TYPES.has(value.category as TripPlaceType)
    || !Number.isFinite(value.latitude)
    || !Number.isFinite(value.longitude)
  ) {
    invalidResponse();
  }
  if (
    /评分|网红|排队|人均|菜单|热门/.test(JSON.stringify(value))
  ) {
    invalidResponse();
  }
  return {
    id: value.id,
    provider: value.provider,
    providerPlaceId: value.providerPlaceId,
    name: value.name,
    address: value.address,
    latitude: value.latitude,
    longitude: value.longitude,
    category: value.category as TripPlaceType,
  };
}

export function parseMealOptionsPayload(payload: unknown): Place[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.places)) {
    invalidResponse();
  }
  if (Object.keys(payload.data).length !== 1) {
    invalidResponse();
  }
  if (payload.data.places.length > 6) {
    invalidResponse();
  }
  return payload.data.places.map((item) => readPlace(item));
}

function readMealSummary(value: unknown): SelectMealPlaceSummary {
  if (!isRecord(value)) {
    invalidResponse();
  }
  if (
    value.type !== 'SELECT_MEAL_PLACE'
    || typeof value.dayNumber !== 'number'
    || typeof value.mealSlotId !== 'string'
    || typeof value.nextPlaceName !== 'string'
    || typeof value.routeRecalculated !== 'boolean'
  ) {
    invalidResponse();
  }
  return {
    type: 'SELECT_MEAL_PLACE',
    dayNumber: value.dayNumber,
    mealSlotId: value.mealSlotId,
    nextPlaceName: value.nextPlaceName.trim(),
    routeRecalculated: value.routeRecalculated,
  };
}

export function parseMealApplyPayload(payload: unknown): TripMealApplyResult {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    invalidResponse();
  }
  const trip = parseInternalTrip(payload.data.trip);
  return {
    trip,
    places: parseInternalPlaces(payload.data.places, trip),
    summary: readMealSummary(payload.data.summary),
  };
}

export class BffTripMealService {
  private readonly client: BffHttpClient;

  constructor(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.client = new BffHttpClient(fetchImpl, 8_000, TRIP_CHANGE_APPLY_TIMEOUT_MS);
  }

  async listOptions(input: MealOptionsRequest): Promise<Place[]> {
    if (typeof input.city !== 'string' || input.city.trim() === '') {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const body: Record<string, unknown> = {
      city: input.city.trim(),
      mealPeriod: input.mealPeriod,
      area: {
        placeId: input.area.placeId,
        name: input.area.name,
        longitude: input.area.longitude,
        latitude: input.area.latitude,
      },
    };
    if (input.nextPlace) {
      body.nextPlace = {
        placeId: input.nextPlace.placeId,
        name: input.nextPlace.name,
        longitude: input.nextPlace.longitude,
        latitude: input.nextPlace.latitude,
      };
    }
    if (input.category) {
      body.category = input.category;
    }
    const payload = await this.client.post(TRIP_MEAL_OPTIONS_PATH, body, 20_000);
    return parseMealOptionsPayload(payload);
  }

  async apply(input: {
    trip: Trip;
    places: Place[];
    dayNumber: number;
    mealSlotId: string;
    placeId: string;
    expectedTripId: string;
  }): Promise<TripMealApplyResult> {
    if (input.trip.id !== input.expectedTripId) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }
    const payload = await this.client.post(TRIP_MEAL_APPLY_PATH, {
      trip: structuredClone(input.trip),
      places: structuredClone(input.places),
      operation: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: input.dayNumber,
        mealSlotId: input.mealSlotId,
        placeId: input.placeId,
      },
    }, TRIP_CHANGE_APPLY_TIMEOUT_MS);
    return parseMealApplyPayload(payload);
  }
}

export const tripMealService = new BffTripMealService();
