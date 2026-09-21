import { tripPlaceTypeLabel } from '../../src/services/trip-display';
import type { TripPlaceType } from '../../src/domain/trip/types';
import type { TripPlanPlaceCategory } from './trip-plan-generator';
import {
  normalizeTripChangePlaceName,
  normalizeTripChangeUtterance,
  type TripChangeContext,
  type TripChangeContextStop,
  type TripChangeFocus,
  type TripChangeIntent,
} from './trip-change-intent-extractor';

export type TripChangeInternalIntentType =
  | 'REPLACE_WITH_EXACT_PLACE'
  | 'REPLACE_WITH_CATEGORY'
  | 'DISCOVER_NEARBY_OPTIONS'
  | 'CLARIFY';

export type TripChangeSourceGrounding =
  | 'RESOLVED'
  | 'AMBIGUOUS'
  | 'NOT_IN_CURRENT_DAY'
  | 'NOT_IN_TRIP';

export type TripChangeTargetKind = 'exact_place' | 'category';

export type { TripChangeFocus };

export interface TripChangePublicCandidate {
  placeId: string;
  name: string;
  categoryLabel: string;
  relation: string;
}

export interface TripChangeSourceChoice {
  tripPlaceId: string;
  placeName: string;
}

export interface TripChangePendingReplace {
  dayNumber: number;
  targetTripPlaceId: string;
}

export interface TripChangePublicIntent {
  status: 'ready' | 'needs_clarification' | 'needs_choice';
  summary: string;
  operations: TripChangeIntent['operations'];
  candidates?: TripChangePublicCandidate[];
  sourceChoices?: TripChangeSourceChoice[];
  pendingReplace?: TripChangePendingReplace;
}

export interface RefinedTripChangeIntent {
  intentType: TripChangeInternalIntentType;
  publicIntent: TripChangePublicIntent;
  targetKind: TripChangeTargetKind | 'none';
  targetCategory?: TripPlanPlaceCategory;
  searchQuery?: string;
  sourceStop?: TripChangeContextStop & { dayNumber: number };
  nextStopName?: string;
  sourceGrounding?: TripChangeSourceGrounding;
  sourceReference?: string;
}

const CATEGORY_RULES: Array<{
  pattern: RegExp;
  category: TripPlanPlaceCategory;
  query: string;
  label: string;
}> = [
  { pattern: /逛街|购物中心|商场|购物/, category: 'shopping', query: '商场', label: '商场' },
  { pattern: /博物馆/, category: 'sight', query: '博物馆', label: '博物馆' },
  { pattern: /咖啡馆|咖啡店|咖啡/, category: 'coffee', query: '咖啡馆', label: '咖啡馆' },
  { pattern: /公园/, category: 'sight', query: '公园', label: '公园' },
  { pattern: /餐厅|饭店|吃饭/, category: 'food', query: '餐厅', label: '餐厅' },
];

const CATEGORY_QUERY_NAMES = new Set(
  CATEGORY_RULES.flatMap((rule) => [rule.query, rule.label]),
);

const CN_DAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function isBareCategoryName(name: string): boolean {
  const stripped = name.replace(/别的|其他的|其他|另外的|另外|附近的|附近|一个|一家|个/g, '').trim();
  return CATEGORY_QUERY_NAMES.has(stripped) || CATEGORY_QUERY_NAMES.has(normalizeTripChangePlaceName(stripped));
}

export function isCategoryReplacementQuery(query: string): boolean {
  const stripped = query.replace(/别的|其他的|其他|另外的|另外|附近的|附近|一个|一家|个/g, '').trim();
  const normalized = normalizeTripChangePlaceName(stripped);
  return CATEGORY_QUERY_NAMES.has(stripped)
    || CATEGORY_QUERY_NAMES.has(normalized)
    || detectChangeCategory(stripped) !== undefined;
}

export function detectReplaceIntent(input: string): boolean {
  return /换个|换一个|换成|改成|不想去|不去了|不去|不要去|想去别的|想去一个/.test(input);
}

export function detectExplicitMealSource(input: string): boolean {
  return /午餐|晚餐|午饭|晚饭|餐厅|餐馆|吃饭|咖啡/.test(input);
}

export function detectExplicitHotelSource(input: string): boolean {
  return /酒店|住宿|宾馆/.test(input);
}

export function detectChangeCategory(input: string): {
  category: TripPlanPlaceCategory;
  query: string;
  label: string;
} | undefined {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(input)) {
      return { category: rule.category, query: rule.query, label: rule.label };
    }
  }
  return undefined;
}

export function detectDiscoverIntent(input: string): boolean {
  if (detectReplaceIntent(input)) {
    return false;
  }
  return /给我几个|有什么适合|推荐几个|附近有什么|附近有哪些/.test(input);
}

export function detectDayNumber(input: string, focus?: TripChangeFocus): number | undefined {
  const numeric = input.match(/第\s*(\d+)\s*天/u);
  if (numeric) {
    return Number(numeric[1]);
  }
  const named = input.match(/第([一二三四五六七八九十])天/u);
  if (named && CN_DAY[named[1]]) {
    return CN_DAY[named[1]];
  }
  if (/第二天/.test(input)) {
    return 2;
  }
  if (/第一天|今天|当天/.test(input)) {
    return focus?.selectedDayNumber ?? 1;
  }
  return focus?.selectedDayNumber;
}

function stopsForDay(
  context: TripChangeContext,
  dayNumber: number,
): Array<TripChangeContextStop & { dayNumber: number }> {
  const day = context.days.find((item) => item.dayNumber === dayNumber);
  if (!day) {
    return [];
  }
  return day.stops.map((stop) => ({ ...stop, dayNumber }));
}

function visitableStops(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): Array<TripChangeContextStop & { dayNumber: number }> {
  return sightseeingStops(stops);
}

export function sightseeingStops(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): Array<TripChangeContextStop & { dayNumber: number }> {
  return stops.filter((stop) => (
    stop.type === 'attraction'
    || stop.type === 'activity'
    || stop.type === 'shopping'
  ));
}

export function mealStops(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): Array<TripChangeContextStop & { dayNumber: number }> {
  return stops.filter((stop) => stop.type === 'restaurant' || stop.type === 'cafe');
}

export function hotelStops(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): Array<TripChangeContextStop & { dayNumber: number }> {
  return stops.filter((stop) => stop.type === 'hotel');
}

export function replaceableSourceStops(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
  input: string,
): Array<TripChangeContextStop & { dayNumber: number }> {
  if (detectExplicitHotelSource(input)) {
    return hotelStops(stops);
  }
  if (detectExplicitMealSource(input)) {
    return mealStops(stops);
  }
  return sightseeingStops(stops);
}

export function matchMentionedStops(
  input: string,
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): Array<TripChangeContextStop & { dayNumber: number }> {
  const normalizedInput = normalizeTripChangePlaceName(normalizeTripChangeUtterance(input));
  const ranked = [...stops].sort((left, right) => right.placeName.length - left.placeName.length);
  const matched: Array<TripChangeContextStop & { dayNumber: number }> = [];
  for (const stop of ranked) {
    const name = normalizeTripChangePlaceName(stop.placeName);
    if (name.length < 2) {
      continue;
    }
    const aliasHit = name.length >= 3 && [...name].length >= 3 && windowMentioned(normalizedInput, name);
    if (
      (normalizedInput.includes(name) || aliasHit)
      && !matched.some((item) => item.tripPlaceId === stop.tripPlaceId)
    ) {
      matched.push(stop);
    }
  }
  return matched;
}

function windowMentioned(input: string, placeName: string): boolean {
  if (input.includes(placeName)) {
    return true;
  }
  const min = Math.min(3, placeName.length);
  for (let size = placeName.length; size >= min; size -= 1) {
    for (let start = 0; start + size <= placeName.length; start += 1) {
      const part = placeName.slice(start, start + size);
      if (part.length < min || detectChangeCategory(part)) {
        continue;
      }
      if (input.includes(part)) {
        return true;
      }
    }
  }
  return false;
}

function pickByTimeOfDay(
  input: string,
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): (TripChangeContextStop & { dayNumber: number }) | undefined {
  const visit = visitableStops(stops);
  if (/下午|傍晚/.test(input)) {
    return visit.find((stop) => stop.startTime >= '14:00') ?? visit[visit.length - 1];
  }
  if (/上午|早上/.test(input)) {
    return visit.find((stop) => stop.startTime < '12:00') ?? visit[0];
  }
  return undefined;
}

function nextStopName(
  context: TripChangeContext,
  source: TripChangeContextStop & { dayNumber: number },
): string | undefined {
  const day = context.days.find((item) => item.dayNumber === source.dayNumber);
  if (!day) {
    return undefined;
  }
  const index = day.stops.findIndex((stop) => stop.tripPlaceId === source.tripPlaceId);
  return day.stops[index + 1]?.placeName;
}

function clarifySummary(
  dayNumber: number,
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): string {
  const names = stops.slice(0, 3).map((stop) => `“${stop.placeName}”`);
  if (names.length >= 2) {
    return `你想替换 Day ${dayNumber} 的${names[0]}还是${names[1]}？`;
  }
  if (names.length === 1) {
    return `你是想替换 Day ${dayNumber} 的${names[0]}吗？`;
  }
  return `请说明要调整 Day ${dayNumber} 的哪一个地点。`;
}

function toSourceChoices(
  stops: Array<TripChangeContextStop & { dayNumber: number }>,
): TripChangeSourceChoice[] {
  return stops.slice(0, 3).map((stop) => ({
    tripPlaceId: stop.tripPlaceId,
    placeName: stop.placeName,
  }));
}

export function extractSourceReference(input: string): string | undefined {
  const utterance = normalizeTripChangeUtterance(input);
  const patterns = [
    /(?:不想去|不要去|不去)(.+?)(?:想去|换成|换一个|换个|了|$)/,
    /把(.+?)(?:换成|换一个|换个)/,
  ];
  for (const pattern of patterns) {
    const match = utterance.match(pattern);
    if (!match) {
      continue;
    }
    const name = match[1]
      .replace(/了$/u, '')
      .replace(/(?:附近)?(?:别的|其他的|其他|另外的|另外)(?:商场|购物中心|博物馆|公园|咖啡馆|咖啡|餐厅)$/u, '')
      .trim();
    if (name.length >= 2 && !isBareCategoryName(name) && !/^(?:别的|其他|另外)/.test(name)) {
      return name;
    }
  }
  return undefined;
}

export function notInCurrentDaySummary(dayNumber: number, placeName: string): string {
  return `当前 Day ${dayNumber} 中没有“${placeName}”。你是在调整另一条行程，还是想替换今天的哪个地点？`;
}

export function notInTripSummary(placeName: string): string {
  return `当前行程中没有“${placeName}”。请选择今天要替换的地点，或换一条行程。`;
}

export function candidateRelation(sourceName: string, nextName?: string): string {
  if (nextName) {
    return `在「${sourceName}」附近，顺路去「${nextName}」之前`;
  }
  return `在「${sourceName}」附近`;
}

export function publicCategoryLabel(type: TripPlaceType): string {
  return tripPlaceTypeLabel[type];
}

export function refineTripChangeIntent(
  input: string,
  context: TripChangeContext,
  aiIntent: TripChangeIntent,
  focus?: TripChangeFocus,
): RefinedTripChangeIntent {
  const utterance = normalizeTripChangeUtterance(input);
  const category = detectChangeCategory(utterance)
    ?? (
      aiIntent.status === 'ready'
        && aiIntent.operations[0]?.type === 'REPLACE_PLACE'
        && isCategoryReplacementQuery(aiIntent.operations[0].replacementQuery)
        ? detectChangeCategory(aiIntent.operations[0].replacementQuery)
        : undefined
    );
  const discover = detectDiscoverIntent(utterance) && Boolean(category);
  const dayNumber = detectDayNumber(utterance, focus)
    ?? aiIntent.operations[0]?.dayNumber
    ?? context.days[0]?.dayNumber;
  const dayStops = dayNumber ? stopsForDay(context, dayNumber) : [];
  const allStops = context.days.flatMap((day) => (
    day.stops.map((stop) => ({ ...stop, dayNumber: day.dayNumber }))
  ));
  const allowedOnDay = replaceableSourceStops(dayStops, utterance);
  const sourceReference = extractSourceReference(utterance);
  const mentionedOnDay = matchMentionedStops(
    sourceReference ?? utterance,
    allowedOnDay,
  );
  const mentionedInTrip = matchMentionedStops(
    sourceReference ?? utterance,
    replaceableSourceStops(allStops, utterance),
  );
  const focusStop = focus?.sourceTripPlaceId
    ? allowedOnDay.find((stop) => stop.tripPlaceId === focus.sourceTripPlaceId)
    : undefined;
  const timed = sourceReference ? undefined : pickByTimeOfDay(utterance, allowedOnDay);
  const uniqueAllowed = allowedOnDay;
  const categoryStop = !sourceReference && category
    ? uniqueAllowed.filter((stop) => (
      category.category === 'shopping' ? stop.type === 'shopping'
        : category.category === 'coffee' ? stop.type === 'cafe'
          : category.category === 'food' ? stop.type === 'restaurant'
            : false
    ))
    : [];

  const grounded = groundSource({
    sourceReference,
    mentionedOnDay,
    mentionedInTrip,
    focusStop,
    categoryStop,
    timed,
    uniqueAllowed,
    dayNumber: dayNumber ?? 1,
  });

  if (grounded.status === 'NOT_IN_CURRENT_DAY' || grounded.status === 'NOT_IN_TRIP') {
    const placeName = sourceReference ?? mentionedInTrip[0]?.placeName ?? '该地点';
    const summary = grounded.status === 'NOT_IN_CURRENT_DAY'
      ? notInCurrentDaySummary(dayNumber ?? 1, placeName)
      : notInTripSummary(placeName);
    return {
      intentType: 'CLARIFY',
      targetKind: category ? 'category' : 'none',
      targetCategory: category?.category,
      searchQuery: category?.query,
      sourceGrounding: grounded.status,
      sourceReference: placeName,
      publicIntent: {
        status: 'needs_clarification',
        summary,
        operations: [],
        sourceChoices: toSourceChoices(uniqueAllowed),
      },
    };
  }

  if (
    aiIntent.status === 'ready'
    && aiIntent.operations[0]?.type === 'REPLACE_PLACE'
    && !category
    && grounded.status === 'RESOLVED'
  ) {
    return {
      intentType: 'REPLACE_WITH_EXACT_PLACE',
      targetKind: 'exact_place',
      sourceGrounding: 'RESOLVED',
      sourceStop: grounded.source,
      publicIntent: {
        status: 'ready',
        summary: aiIntent.summary,
        operations: aiIntent.operations,
      },
    };
  }

  const source = grounded.source;
  if (category && source && grounded.status === 'RESOLVED') {
    const nextName = nextStopName(context, source);
    const summary = discover
      ? `${source.placeName}附近可以考虑这些${category.label}：`
      : `${source.placeName}可以换成这些顺路的${category.label}：`;
    return {
      intentType: discover ? 'DISCOVER_NEARBY_OPTIONS' : 'REPLACE_WITH_CATEGORY',
      targetKind: 'category',
      targetCategory: category.category,
      searchQuery: category.query,
      sourceStop: source,
      nextStopName: nextName,
      sourceGrounding: 'RESOLVED',
      sourceReference,
      publicIntent: {
        status: 'needs_choice',
        summary,
        operations: [],
        pendingReplace: {
          dayNumber: source.dayNumber,
          targetTripPlaceId: source.tripPlaceId,
        },
      },
    };
  }

  if (grounded.status === 'AMBIGUOUS') {
    return {
      intentType: 'CLARIFY',
      targetKind: category ? 'category' : 'none',
      targetCategory: category?.category,
      searchQuery: category?.query,
      sourceGrounding: 'AMBIGUOUS',
      sourceReference,
      publicIntent: {
        status: 'needs_clarification',
        summary: clarifySummary(dayNumber ?? uniqueAllowed[0]?.dayNumber ?? 1, uniqueAllowed),
        operations: [],
        sourceChoices: toSourceChoices(uniqueAllowed),
      },
    };
  }

  return {
    intentType: aiIntent.status === 'ready' ? 'REPLACE_WITH_EXACT_PLACE' : 'CLARIFY',
    targetKind: aiIntent.status === 'ready' ? 'exact_place' : 'none',
    sourceGrounding: grounded.status,
    publicIntent: {
      status: aiIntent.status,
      summary: aiIntent.summary,
      operations: aiIntent.operations,
    },
  };
}

function groundSource(input: {
  sourceReference?: string;
  mentionedOnDay: Array<TripChangeContextStop & { dayNumber: number }>;
  mentionedInTrip: Array<TripChangeContextStop & { dayNumber: number }>;
  focusStop?: TripChangeContextStop & { dayNumber: number };
  categoryStop: Array<TripChangeContextStop & { dayNumber: number }>;
  timed?: TripChangeContextStop & { dayNumber: number };
  uniqueAllowed: Array<TripChangeContextStop & { dayNumber: number }>;
  dayNumber: number;
}): {
  status: TripChangeSourceGrounding;
  source?: TripChangeContextStop & { dayNumber: number };
} {
  if (input.mentionedOnDay.length === 1) {
    return { status: 'RESOLVED', source: input.mentionedOnDay[0] };
  }
  if (input.mentionedOnDay.length > 1) {
    return { status: 'AMBIGUOUS' };
  }
  if (input.sourceReference) {
    if (input.mentionedInTrip.length > 0) {
      return { status: 'NOT_IN_CURRENT_DAY' };
    }
    return { status: 'NOT_IN_TRIP' };
  }
  if (input.focusStop) {
    return { status: 'RESOLVED', source: input.focusStop };
  }
  if (input.categoryStop.length === 1) {
    return { status: 'RESOLVED', source: input.categoryStop[0] };
  }
  if (input.timed) {
    return { status: 'RESOLVED', source: input.timed };
  }
  if (input.uniqueAllowed.length === 1) {
    return { status: 'RESOLVED', source: input.uniqueAllowed[0] };
  }
  if (input.uniqueAllowed.length > 1) {
    return { status: 'AMBIGUOUS' };
  }
  return { status: 'AMBIGUOUS' };
}

export const EMPTY_NEARBY_CHOICE_SUMMARY = '暂时没有找到合适的附近选择。可以换一个类别，或直接指定地点名称。';

export function emptyNearbyChoiceSummary(sourceName: string, categoryLabel: string): string {
  return `${sourceName}附近暂时没有找到合适的${categoryLabel}选择。你也可以换成博物馆、咖啡馆或指定一个地点。`;
}

export const HEURISTIC_CLARIFY_INTENT: TripChangeIntent = {
  status: 'needs_clarification',
  summary: '请说明要调整哪一个地点。',
  operations: [],
};
