export const CORE_EXPERIENCE_GROUPS = [
  'museum',
  'heritage',
  'park_garden',
  'street_district',
  'landmark_architecture',
  'activity',
  'unknown',
] as const;

export type CoreExperienceGroup = typeof CORE_EXPERIENCE_GROUPS[number];

export const SAME_DAY_DIVERSITY_PENALTY_ONE = 10;
export const SAME_DAY_DIVERSITY_PENALTY_MANY = 25;
