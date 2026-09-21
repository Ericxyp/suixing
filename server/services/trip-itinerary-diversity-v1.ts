import type { Place } from '../../src/domain/trip/types';
import {
  SAME_DAY_DIVERSITY_PENALTY_MANY,
  SAME_DAY_DIVERSITY_PENALTY_ONE,
  type CoreExperienceGroup,
} from '../../src/domain/trip/itinerary-diversity-v1';

const CORE_PLACE_CATEGORIES = new Set<Place['category']>(['attraction', 'activity']);

const MUSEUM = /博物馆|美术馆|展览馆|纪念馆/;
const PARK = /公园|园林|湿地|植物园|动物园/;
const STREET = /胡同|老街|历史街区|里弄|古镇/;
const HERITAGE = /故宫|古迹|遗址|祠|庙|寺|皇城/;
const LANDMARK = /地标|城楼|城门|塔|广场|桥/;

function haystack(place: Pick<Place, 'name' | 'category'>, queryText?: string): string {
  return `${place.name} ${queryText ?? ''}`.normalize('NFKC');
}

export function deriveCoreExperienceGroupV1(
  place: Pick<Place, 'name' | 'category'>,
  queryText?: string,
): CoreExperienceGroup {
  try {
    if (!CORE_PLACE_CATEGORIES.has(place.category)) {
      return 'unknown';
    }
    const text = haystack(place, queryText);
    if (MUSEUM.test(text)) {
      return 'museum';
    }
    if (PARK.test(text)) {
      return 'park_garden';
    }
    if (STREET.test(text)) {
      return 'street_district';
    }
    if (HERITAGE.test(text)) {
      return 'heritage';
    }
    if (LANDMARK.test(text)) {
      return 'landmark_architecture';
    }
    if (place.category === 'activity') {
      return 'activity';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function calculateSameDayDiversityPenaltyV1(input: {
  candidate: Pick<Place, 'name' | 'category'>;
  existingCoreStops?: readonly Pick<Place, 'name' | 'category'>[];
  queryText?: string;
}): number {
  try {
    if (!CORE_PLACE_CATEGORIES.has(input.candidate.category)) {
      return 0;
    }
    const group = deriveCoreExperienceGroupV1(input.candidate, input.queryText);
    if (group === 'unknown') {
      return 0;
    }
    const same = (input.existingCoreStops ?? []).filter((stop) => (
      CORE_PLACE_CATEGORIES.has(stop.category)
      && deriveCoreExperienceGroupV1(stop) === group
    )).length;
    if (same <= 0) {
      return 0;
    }
    if (same === 1) {
      return SAME_DAY_DIVERSITY_PENALTY_ONE;
    }
    return SAME_DAY_DIVERSITY_PENALTY_MANY;
  } catch {
    return 0;
  }
}
