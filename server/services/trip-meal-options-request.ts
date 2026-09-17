import type { TripMealPeriod } from '../../src/domain/trip/types';
import { isFiniteGeoPoint } from './trip-route-enricher';
import type { MealAreaContext, MealOptionsCategory } from './trip-meal-options';

const CITY_MAX = 40;
const NAME_MAX = 80;
const PLACE_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const BODY_KEYS = new Set(['city', 'mealPeriod', 'area', 'nextPlace', 'category']);
const AREA_KEYS = new Set(['placeId', 'name', 'longitude', 'latitude']);
const FORBIDDEN = new Set([
  'key',
  'jscode',
  'sig',
  'url',
  'prompt',
  'schema',
  'model',
  'trip',
  'polyline',
  'budget',
  'query',
  'apiKey',
  'baseUrl',
  'authorization',
]);

export interface ParsedMealOptionsRequest {
  city: string;
  mealPeriod: TripMealPeriod;
  area: MealAreaContext;
  nextPlace?: MealAreaContext;
  category?: MealOptionsCategory;
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
  return Object.keys(value).some((key) => (
    FORBIDDEN.has(key)
    || /https?:/i.test(key)
    || containsForbidden(value[key])
  ));
}

function readText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (text === '' || text.length > max || /https?:\/\//i.test(text) || text.includes('\\')) {
    return undefined;
  }
  return text;
}

function readArea(value: unknown): MealAreaContext | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !AREA_KEYS.has(key))) {
    return undefined;
  }
  const placeId = readText(value.placeId, 80);
  const name = readText(value.name, NAME_MAX);
  if (!placeId || !PLACE_ID.test(placeId) || !name) {
    return undefined;
  }
  const geo = {
    latitude: value.latitude,
    longitude: value.longitude,
  };
  if (!isFiniteGeoPoint(geo)) {
    return undefined;
  }
  return {
    placeId,
    name,
    latitude: geo.latitude,
    longitude: geo.longitude,
  };
}

export function parseMealOptionsBody(body: unknown): ParsedMealOptionsRequest | undefined {
  if (!isRecord(body) || containsForbidden(body)) {
    return undefined;
  }
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    return undefined;
  }
  const city = readText(body.city, CITY_MAX);
  if (!city || (body.mealPeriod !== 'lunch' && body.mealPeriod !== 'dinner')) {
    return undefined;
  }
  const area = readArea(body.area);
  if (!area) {
    return undefined;
  }
  const parsed: ParsedMealOptionsRequest = {
    city,
    mealPeriod: body.mealPeriod,
    area,
  };
  if (body.nextPlace !== undefined) {
    const nextPlace = readArea(body.nextPlace);
    if (!nextPlace) {
      return undefined;
    }
    parsed.nextPlace = nextPlace;
  }
  if (body.category !== undefined) {
    if (body.category !== 'local' && body.category !== 'quick' && body.category !== 'coffee') {
      return undefined;
    }
    parsed.category = body.category;
  }
  return parsed;
}
