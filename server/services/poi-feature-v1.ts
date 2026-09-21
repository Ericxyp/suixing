import type { Place, TripPlaceType } from '../../src/domain/trip/types';
import type { TravelInterestKey } from '../../src/domain/trip/profile';

export interface PoiFeatureV1 {
  placeId: string;
  category: TripPlaceType;
  interestKeys: TravelInterestKey[];
  indoorBias: number;
  outdoorBias: number;
  walkingBurden: number;
}

const CATEGORY_FEATURES: Record<TripPlaceType, Pick<PoiFeatureV1, 'interestKeys' | 'indoorBias' | 'outdoorBias' | 'walkingBurden'>> = {
  attraction: {
    interestKeys: ['history', 'culture_art', 'architecture'],
    indoorBias: 0.4,
    outdoorBias: 0.6,
    walkingBurden: 0.6,
  },
  activity: {
    interestKeys: ['local_life', 'photography'],
    indoorBias: 0.3,
    outdoorBias: 0.7,
    walkingBurden: 0.7,
  },
  shopping: {
    interestKeys: ['shopping'],
    indoorBias: 0.8,
    outdoorBias: 0.2,
    walkingBurden: 0.5,
  },
  restaurant: {
    interestKeys: ['food'],
    indoorBias: 0.8,
    outdoorBias: 0.2,
    walkingBurden: 0.2,
  },
  cafe: {
    interestKeys: ['coffee'],
    indoorBias: 0.7,
    outdoorBias: 0.3,
    walkingBurden: 0.2,
  },
  hotel: {
    interestKeys: [],
    indoorBias: 1,
    outdoorBias: 0,
    walkingBurden: 0.1,
  },
  transport: {
    interestKeys: [],
    indoorBias: 0.5,
    outdoorBias: 0.5,
    walkingBurden: 0.4,
  },
};

export function derivePoiFeatureV1(place: Pick<Place, 'id' | 'category'>): PoiFeatureV1 {
  const derived = CATEGORY_FEATURES[place.category];
  return {
    placeId: place.id,
    category: place.category,
    interestKeys: [...derived.interestKeys],
    indoorBias: derived.indoorBias,
    outdoorBias: derived.outdoorBias,
    walkingBurden: derived.walkingBurden,
  };
}
