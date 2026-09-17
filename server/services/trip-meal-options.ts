import type { Place, TripMealPeriod, TripPlaceType } from '../../src/domain/trip/types';
import { filterEligibleTripPlaces } from './trip-place-eligibility';
import type { PlaceSearchService } from './trip-place-resolver';
import { haversineMeters, isFiniteGeoPoint } from './trip-route-enricher';

export const MEAL_OPTIONS_LIMIT = 6;
export const MEAL_OPTIONS_SEARCH_LIMIT = 10;

export type MealOptionsCategory = 'local' | 'quick' | 'coffee';

export interface MealAreaContext {
  placeId: string;
  name: string;
  longitude: number;
  latitude: number;
}

export async function searchMealDiningPlaces(input: {
  city: string;
  mealPeriod: TripMealPeriod;
  area: Pick<Place, 'id' | 'name' | 'latitude' | 'longitude'>;
  nextPlace?: Pick<Place, 'id' | 'latitude' | 'longitude'>;
  category?: MealOptionsCategory;
  placeSearch: PlaceSearchService;
  signal?: AbortSignal;
}): Promise<Place[]> {
  void input.mealPeriod;
  void input.signal;
  const wantCafe = input.category === 'coffee';
  const allowed: ReadonlySet<TripPlaceType> = new Set(wantCafe ? ['cafe'] : ['restaurant', 'cafe']);
  const primaryQuery = wantCafe ? `${input.area.name} 咖啡馆` : `${input.area.name} 餐厅`;
  const fallbackQuery = wantCafe ? `${input.city} 咖啡馆` : `${input.city} 餐厅`;
  const used = new Set<string>();
  const collected: Place[] = [];

  const first = await input.placeSearch.search({
    query: primaryQuery,
    city: input.city,
    limit: MEAL_OPTIONS_SEARCH_LIMIT,
  });
  collectEligible(first, allowed, used, collected);
  if (collected.length === 0) {
    const second = await input.placeSearch.search({
      query: fallbackQuery,
      city: input.city,
      limit: MEAL_OPTIONS_SEARCH_LIMIT,
    });
    collectEligible(second, allowed, used, collected);
  }

  const areaPoint = { latitude: input.area.latitude, longitude: input.area.longitude };
  const nextPoint = input.nextPlace
    ? { latitude: input.nextPlace.latitude, longitude: input.nextPlace.longitude }
    : undefined;
  collected.sort((left, right) => {
    const leftScore = mealDistanceScore(left, areaPoint, nextPoint);
    const rightScore = mealDistanceScore(right, areaPoint, nextPoint);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.id.localeCompare(right.id);
  });
  return collected.slice(0, MEAL_OPTIONS_LIMIT).map((place) => ({
    id: place.id,
    provider: place.provider,
    providerPlaceId: place.providerPlaceId,
    name: place.name,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    category: place.category,
  }));
}

function collectEligible(
  places: Place[],
  allowed: ReadonlySet<TripPlaceType>,
  used: Set<string>,
  collected: Place[],
): void {
  const suggestion = {
    name: '餐厅',
    query: '餐厅',
    category: (allowed.has('cafe') && !allowed.has('restaurant') ? 'coffee' : 'food') as 'food' | 'coffee',
    suggestedStartTime: '12:00',
    suggestedDurationMinutes: 60,
    reason: '餐饮候选。',
  };
  for (const place of filterEligibleTripPlaces(places, suggestion)) {
    if (
      used.has(place.id)
      || !allowed.has(place.category)
      || !isFiniteGeoPoint(place)
    ) {
      continue;
    }
    used.add(place.id);
    collected.push(place);
  }
}

function mealDistanceScore(
  place: Place,
  area: { latitude: number; longitude: number },
  next?: { latitude: number; longitude: number },
): number {
  const toArea = haversineMeters(place, area);
  if (!next) {
    return toArea;
  }
  return toArea + haversineMeters(place, next);
}
