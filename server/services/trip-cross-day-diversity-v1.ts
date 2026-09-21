import type { Place } from '../../src/domain/trip/types';
import {
  CROSS_DAY_DIVERSITY_PENALTY_MANY_DAYS,
  CROSS_DAY_DIVERSITY_PENALTY_ONE_DAY,
} from '../../src/domain/trip/cross-day-diversity-v1';
import { deriveCoreExperienceGroupV1 } from './trip-itinerary-diversity-v1';

const CORE_PLACE_CATEGORIES = new Set<Place['category']>(['attraction', 'activity']);

export interface CrossDayDiversityCoreStopV1 {
  dayNumber: number;
  place: Pick<Place, 'name' | 'category'>;
}

export interface CrossDayDiversityInputV1 {
  candidate: Place;
  completedPreviousDayCoreStops?: readonly CrossDayDiversityCoreStopV1[];
  queryText?: string;
}

export interface CrossDayDiversityResultV1 {
  penalty: number;
}

export function calculateCrossDayDiversityPenaltyV1(
  input: CrossDayDiversityInputV1,
): CrossDayDiversityResultV1 {
  try {
    if (!input.completedPreviousDayCoreStops?.length) {
      return { penalty: 0 };
    }
    if (!CORE_PLACE_CATEGORIES.has(input.candidate.category)) {
      return { penalty: 0 };
    }
    const group = deriveCoreExperienceGroupV1(input.candidate, input.queryText);
    if (group === 'unknown') {
      return { penalty: 0 };
    }
    const daysWithGroup = new Set<number>();
    for (const stop of input.completedPreviousDayCoreStops) {
      if (!CORE_PLACE_CATEGORIES.has(stop.place.category)) {
        continue;
      }
      if (!Number.isFinite(stop.dayNumber)) {
        continue;
      }
      if (deriveCoreExperienceGroupV1(stop.place) === group) {
        daysWithGroup.add(stop.dayNumber);
      }
    }
    if (daysWithGroup.size <= 0) {
      return { penalty: 0 };
    }
    if (daysWithGroup.size === 1) {
      return { penalty: CROSS_DAY_DIVERSITY_PENALTY_ONE_DAY };
    }
    return { penalty: CROSS_DAY_DIVERSITY_PENALTY_MANY_DAYS };
  } catch {
    return { penalty: 0 };
  }
}
