import type { Place, TripPace, TripPlaceType } from '../../src/domain/trip/types';
import type { TripPlanPlaceCategory } from './trip-plan-generator';
import { normalizePlaceName } from './trip-place-resolver';

/**
 * 随行产品停留时长策略。POI 只提供地点身份与基础分类，
 * 这些分钟数不是高德营业时间、评分或客流数据。
 */
export interface StopDurationBounds {
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
}

export type StopDurationRuleSource =
  | 'USER_EXPLICIT'
  | 'PLACE_ID_RULE'
  | 'PLACE_NAME_RULE'
  | 'SCALE_HINT'
  | 'CATEGORY_DEFAULT'
  | 'UNKNOWN_DEFAULT';

export interface MatchedStopDurationRule extends StopDurationBounds {
  source: Exclude<StopDurationRuleSource, 'USER_EXPLICIT'>;
}

interface NamedDurationRule extends StopDurationBounds {
  aliases: readonly string[];
  cities?: readonly string[];
}

export const NATIONAL_MUSEUM_DURATION: StopDurationBounds = {
  defaultMinutes: 210,
  minMinutes: 180,
  maxMinutes: 240,
};

export const NATURE_MUSEUM_DURATION: StopDurationBounds = {
  defaultMinutes: 150,
  minMinutes: 120,
  maxMinutes: 180,
};

export const MUSEUM_DURATION: StopDurationBounds = {
  defaultMinutes: 120,
  minMinutes: 90,
  maxMinutes: 180,
};

export const GALLERY_DURATION: StopDurationBounds = {
  defaultMinutes: 90,
  minMinutes: 60,
  maxMinutes: 150,
};

export const SIGHT_DURATION: StopDurationBounds = {
  defaultMinutes: 120,
  minMinutes: 60,
  maxMinutes: 240,
};

export const CAFE_DURATION: StopDurationBounds = {
  defaultMinutes: 60,
  minMinutes: 45,
  maxMinutes: 90,
};

export const RESTAURANT_DURATION: StopDurationBounds = {
  defaultMinutes: 90,
  minMinutes: 60,
  maxMinutes: 120,
};

export const SHOPPING_DURATION: StopDurationBounds = {
  defaultMinutes: 120,
  minMinutes: 60,
  maxMinutes: 180,
};

export const HOTEL_DURATION: StopDurationBounds = {
  defaultMinutes: 30,
  minMinutes: 15,
  maxMinutes: 60,
};

export const UNKNOWN_DURATION: StopDurationBounds = {
  defaultMinutes: 90,
  minMinutes: 60,
  maxMinutes: 150,
};

export const PALACE_MUSEUM_DURATION: StopDurationBounds = {
  defaultMinutes: 180,
  minMinutes: 150,
  maxMinutes: 240,
};

/** 仅匹配已知稳定 Place.id；MVP 默认表为空，测试可通过 options 注入。 */
export const PLACE_ID_DURATION_RULES: Readonly<Record<string, StopDurationBounds>> = {};

const NAMED_DURATION_RULES: readonly NamedDurationRule[] = [
  {
    aliases: ['中国国家博物馆', '国家博物馆'],
    cities: ['北京'],
    ...NATIONAL_MUSEUM_DURATION,
  },
  {
    aliases: ['北京自然博物馆', '国家自然博物馆', '中国自然博物馆'],
    cities: ['北京'],
    ...NATURE_MUSEUM_DURATION,
  },
  {
    aliases: ['故宫博物院'],
    cities: ['北京'],
    ...PALACE_MUSEUM_DURATION,
  },
];

function cityHintMatches(place: Place, destination: string | undefined, cities: readonly string[] | undefined): boolean {
  if (!cities || cities.length === 0) {
    return true;
  }
  const haystacks = [destination ?? '', place.address, place.name].map((item) => normalizePlaceName(item));
  return cities.some((city) => {
    const needle = normalizePlaceName(city);
    return needle !== '' && haystacks.some((haystack) => haystack.includes(needle));
  });
}

function nameMatchesAlias(placeName: string, alias: string): boolean {
  if (placeName === '' || alias === '') {
    return false;
  }
  if (placeName === alias) {
    return true;
  }
  return alias.length >= 4 && placeName.includes(alias);
}

export function matchNamedDurationRule(
  place: Place,
  destination?: string,
  rules: readonly NamedDurationRule[] = NAMED_DURATION_RULES,
): MatchedStopDurationRule | undefined {
  const placeName = normalizePlaceName(place.name);
  for (const rule of rules) {
    if (!cityHintMatches(place, destination, rule.cities)) {
      continue;
    }
    if (rule.aliases.some((alias) => nameMatchesAlias(placeName, normalizePlaceName(alias)))) {
      return {
        source: 'PLACE_NAME_RULE',
        defaultMinutes: rule.defaultMinutes,
        minMinutes: rule.minMinutes,
        maxMinutes: rule.maxMinutes,
      };
    }
  }
  if (
    placeName.includes('国家级')
    && (placeName.includes('博物馆') || placeName.includes('博物院') || placeName.includes('展览馆'))
  ) {
    return { source: 'PLACE_NAME_RULE', ...NATIONAL_MUSEUM_DURATION };
  }
  return undefined;
}

export function matchScaleDurationHint(place: Place): MatchedStopDurationRule | undefined {
  const name = normalizePlaceName(place.name);
  if (name.includes('美术馆') || name.includes('艺术馆')) {
    return { source: 'SCALE_HINT', ...GALLERY_DURATION };
  }
  if (name.includes('博物馆') || name.includes('博物院') || name.includes('展览馆')) {
    return { source: 'SCALE_HINT', ...MUSEUM_DURATION };
  }
  return undefined;
}

export function durationBoundsForCategory(
  placeCategory: TripPlaceType,
  suggestionCategory?: TripPlanPlaceCategory,
): StopDurationBounds {
  const rule = categoryDurationRule(placeCategory, suggestionCategory);
  return {
    defaultMinutes: rule.defaultMinutes,
    minMinutes: rule.minMinutes,
    maxMinutes: rule.maxMinutes,
  };
}

export function matchStopDurationRule(input: {
  place: Place;
  destination?: string;
  suggestionCategory?: TripPlanPlaceCategory;
  pace?: TripPace;
  idRules?: Readonly<Record<string, StopDurationBounds>>;
}): MatchedStopDurationRule {
  const idRules = input.idRules ?? PLACE_ID_DURATION_RULES;
  const idRule = idRules[input.place.id];
  if (idRule) {
    return { source: 'PLACE_ID_RULE', ...idRule };
  }
  const named = matchNamedDurationRule(input.place, input.destination);
  if (named) {
    return named;
  }
  const scale = matchScaleDurationHint(input.place);
  if (scale) {
    return scale;
  }
  return categoryDurationRule(input.place.category, input.suggestionCategory);
}

export function categoryDurationRule(
  placeCategory: TripPlaceType,
  suggestionCategory?: TripPlanPlaceCategory,
): MatchedStopDurationRule {
  if (placeCategory === 'cafe' || suggestionCategory === 'coffee') {
    return { source: 'CATEGORY_DEFAULT', ...CAFE_DURATION };
  }
  if (placeCategory === 'restaurant' || suggestionCategory === 'food') {
    return { source: 'CATEGORY_DEFAULT', ...RESTAURANT_DURATION };
  }
  if (placeCategory === 'shopping' || suggestionCategory === 'shopping') {
    return { source: 'CATEGORY_DEFAULT', ...SHOPPING_DURATION };
  }
  if (placeCategory === 'hotel' || suggestionCategory === 'hotel') {
    return { source: 'CATEGORY_DEFAULT', ...HOTEL_DURATION };
  }
  if (
    placeCategory === 'attraction'
    || placeCategory === 'activity'
    || suggestionCategory === 'sight'
    || suggestionCategory === 'activity'
  ) {
    return { source: 'CATEGORY_DEFAULT', ...SIGHT_DURATION };
  }
  return { source: 'UNKNOWN_DEFAULT', ...UNKNOWN_DURATION };
}
