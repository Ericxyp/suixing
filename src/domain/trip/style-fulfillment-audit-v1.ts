export const STYLE_FULFILLMENT_AUDIT_ITEMS_V1 = [
  'corePlaceCount',
  'excludedInterest',
  'lowWalkingPolicy',
  'intentCoverage',
  'mealArrangement',
] as const;

export type StyleFulfillmentAuditItemKeyV1 = typeof STYLE_FULFILLMENT_AUDIT_ITEMS_V1[number];

export type StyleFulfillmentItemStatusV1 = 'met' | 'not_met' | 'not_evaluable';

export type StyleFulfillmentOverallStatusV1 = 'met' | 'partially_met' | 'not_evaluable';

export interface StyleFulfillmentItemResultV1 {
  status: StyleFulfillmentItemStatusV1;
  /** Internal deterministic reason for tests only. Never expose on Trip / API / UI. */
  reason?: string;
}

export interface StyleFulfillmentAuditV1 {
  overall: StyleFulfillmentOverallStatusV1;
  items: Record<StyleFulfillmentAuditItemKeyV1, StyleFulfillmentItemResultV1>;
}
