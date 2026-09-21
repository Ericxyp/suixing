export const DAY_COMBINATION_SCORE_WEIGHTS_V1 = {
  coreCoverage: 0.25,
  candidateQuality: 0.35,
  diversity: 0.15,
  fatigueRhythm: 0.15,
  routeEfficiency: 0.1,
} as const;

export interface DayCombinationScoreBreakdownV1 {
  coreCoverage: number;
  candidateQuality: number;
  diversity: number;
  fatigueRhythm: number;
  routeEfficiency: number;
}

export interface DayCombinationScoreV1 {
  total: number;
  breakdown: DayCombinationScoreBreakdownV1;
}
