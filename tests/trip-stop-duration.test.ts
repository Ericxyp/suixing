import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Place, TripPace, TripPlaceType } from '../src/domain/trip/types';
import type { TripPlanPlaceCategory } from '../server/services/trip-plan-generator';
import {
  CAFE_DURATION,
  GALLERY_DURATION,
  HOTEL_DURATION,
  matchStopDurationRule,
  MUSEUM_DURATION,
  NATIONAL_MUSEUM_DURATION,
  NATURE_MUSEUM_DURATION,
  RESTAURANT_DURATION,
  SHOPPING_DURATION,
  SIGHT_DURATION,
  UNKNOWN_DURATION,
} from '../server/services/trip-stop-duration-policy';
import {
  applyResolvedTripStopDurations,
  resolveStopDuration,
} from '../server/services/trip-stop-duration-resolver';
import type { ResolvedTripPlanSuggestion } from '../server/services/trip-place-resolver';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '北京市东城区示例路 1 号',
    latitude: 39.9,
    longitude: 116.4,
    category: 'attraction',
    ...overrides,
  };
}

function minutes(
  name: string,
  extras: {
    category?: TripPlaceType;
    address?: string;
    suggested?: number;
    suggestionCategory?: TripPlanPlaceCategory;
    pace?: TripPace;
    destination?: string;
    userExplicit?: number;
    id?: string;
    idRules?: Record<string, { defaultMinutes: number; minMinutes: number; maxMinutes: number }>;
  } = {},
) {
  return resolveStopDuration({
    place: place({
      id: extras.id ?? 'amap:X',
      name,
      category: extras.category ?? 'attraction',
      ...(extras.address ? { address: extras.address } : {}),
    }),
    suggestedDurationMinutes: extras.suggested,
    suggestionCategory: extras.suggestionCategory,
    pace: extras.pace ?? 'balanced',
    destination: extras.destination ?? '北京',
    userExplicitDurationMinutes: extras.userExplicit,
    idRules: extras.idRules,
  });
}

test('same Place.id ignores different AI durations', () => {
  const geYuan = ['个园', { id: 'amap:GEYUAN', destination: '扬州', address: '扬州市广陵区' }] as const;
  const first = minutes(geYuan[0], { ...geYuan[1], suggested: 120 });
  const second = minutes(geYuan[0], { ...geYuan[1], suggested: 150 });
  const third = minutes(geYuan[0], { ...geYuan[1], suggested: 180 });
  assert.equal(first.suggestedDurationMinutes, SIGHT_DURATION.defaultMinutes);
  assert.equal(second.suggestedDurationMinutes, first.suggestedDurationMinutes);
  assert.equal(third.suggestedDurationMinutes, first.suggestedDurationMinutes);
});

test('ordinary sights stay on the category default across AI drafts', () => {
  for (const suggested of [90, 120, 180]) {
    assert.equal(
      minutes('个园', { id: 'amap:GEYUAN', destination: '扬州', address: '扬州市广陵区', suggested }).suggestedDurationMinutes,
      120,
    );
    assert.equal(
      minutes('东关街', { id: 'amap:DONGGUAN', destination: '扬州', address: '扬州市广陵区', suggested }).suggestedDurationMinutes,
      120,
    );
  }
});

test('national museum keeps its dedicated default and is not overwritten by AI', () => {
  assert.equal(minutes('中国国家博物馆', { suggested: 120 }).suggestedDurationMinutes, NATIONAL_MUSEUM_DURATION.defaultMinutes);
  assert.equal(minutes('中国国家博物馆', { suggested: 240 }).suggestedDurationMinutes, NATIONAL_MUSEUM_DURATION.defaultMinutes);
  assert.equal(minutes('北京自然博物馆').suggestedDurationMinutes, NATURE_MUSEUM_DURATION.defaultMinutes);
});

test('category and scale defaults stay in range', () => {
  assert.equal(minutes('上海博物馆', { destination: '上海', suggested: 180 }).suggestedDurationMinutes, MUSEUM_DURATION.defaultMinutes);
  assert.equal(minutes('今日美术馆', { suggested: 60 }).suggestedDurationMinutes, GALLERY_DURATION.defaultMinutes);
  assert.equal(minutes('文昌阁', { destination: '扬州', address: '扬州市广陵区' }).suggestedDurationMinutes, SIGHT_DURATION.defaultMinutes);
  assert.equal(minutes('Manner Coffee', { category: 'cafe', suggestionCategory: 'coffee', suggested: 90 }).suggestedDurationMinutes, CAFE_DURATION.defaultMinutes);
  assert.equal(minutes('佳家汤包', { category: 'restaurant', suggestionCategory: 'food', suggested: 60 }).suggestedDurationMinutes, RESTAURANT_DURATION.defaultMinutes);
  assert.equal(minutes('新天地', { category: 'shopping', suggestionCategory: 'shopping', suggested: 180 }).suggestedDurationMinutes, SHOPPING_DURATION.defaultMinutes);
  assert.equal(minutes('英迪格酒店', { category: 'hotel', suggestionCategory: 'hotel', suggested: 60 }).suggestedDurationMinutes, HOTEL_DURATION.defaultMinutes);
});

test('unknown category may use AI duration as a last resort after clamp and quantize', () => {
  const unknown = {
    category: 'transport' as const,
    suggestionCategory: 'other' as const,
  };
  assert.equal(minutes('未知点', unknown).suggestedDurationMinutes, UNKNOWN_DURATION.defaultMinutes);
  const kept = minutes('未知点', { ...unknown, suggested: 100 });
  assert.equal(kept.suggestedDurationMinutes, 105);
  assert.equal(kept.source, 'UNKNOWN_DEFAULT');
  const clamped = minutes('未知点', { ...unknown, suggested: 30 });
  assert.equal(clamped.suggestedDurationMinutes, 60);
  const high = minutes('未知点', { ...unknown, suggested: 240 });
  assert.equal(high.suggestedDurationMinutes, 150);
});

test('relaxed and packed only adjust the rule default within range', () => {
  assert.equal(
    minutes('个园', { destination: '扬州', suggested: 180, pace: 'relaxed' }).suggestedDurationMinutes,
    135,
  );
  assert.equal(
    minutes('东关街', { destination: '扬州', suggested: 90, pace: 'packed' }).suggestedDurationMinutes,
    105,
  );
  const cafeRelaxed = minutes('Manner Coffee', {
    category: 'cafe',
    suggestionCategory: 'coffee',
    suggested: 90,
    pace: 'relaxed',
  });
  assert.equal(cafeRelaxed.suggestedDurationMinutes, 75);
  const cafePacked = minutes('Manner Coffee', {
    category: 'cafe',
    suggestionCategory: 'coffee',
    pace: 'packed',
  });
  assert.equal(cafePacked.suggestedDurationMinutes, 45);
  assert.equal(minutes('中国国家博物馆', { suggested: 180, pace: 'packed' }).suggestedDurationMinutes, 195);
  assert.equal(minutes('中国国家博物馆', { pace: 'relaxed' }).suggestedDurationMinutes, 225);
  const hotelRelaxed = minutes('英迪格酒店', {
    category: 'hotel',
    suggestionCategory: 'hotel',
    suggested: 60,
    pace: 'relaxed',
  });
  assert.equal(hotelRelaxed.suggestedDurationMinutes, 45);
});

test('user explicit duration beats place rules', () => {
  const decision = minutes('个园', {
    destination: '扬州',
    suggested: 180,
    userExplicit: 60,
  });
  assert.equal(decision.suggestedDurationMinutes, 60);
  assert.equal(decision.source, 'USER_EXPLICIT');
});

test('named museum rules do not fire for the same words in another city', () => {
  const yangzhou = minutes('中国大运河博物馆', {
    destination: '扬州',
    address: '扬州市广陵区',
    suggested: 180,
  });
  assert.equal(yangzhou.source, 'SCALE_HINT');
  assert.equal(yangzhou.suggestedDurationMinutes, 120);
  const namoc = matchStopDurationRule({
    place: place({
      id: 'amap:YZ',
      name: '国家博物馆分馆',
      address: '扬州市广陵区',
    }),
    destination: '扬州',
  });
  assert.notEqual(namoc.source, 'PLACE_NAME_RULE');
});

test('Place.id rules beat name rules when provided', () => {
  const decision = minutes('中国国家博物馆', {
    id: 'amap:CUSTOM',
    suggested: 210,
    idRules: {
      'amap:CUSTOM': { defaultMinutes: 165, minMinutes: 150, maxMinutes: 180 },
    },
  });
  assert.equal(decision.source, 'PLACE_ID_RULE');
  assert.equal(decision.suggestedDurationMinutes, 165);
});

test('applying durations clones the resolved plan and omits source from stops', () => {
  const plan: ResolvedTripPlanSuggestion = {
    title: '扬州 2 天',
    summary: '慢游。',
    unresolved: [],
    days: [{
      dayNumber: 1,
      title: '第一日',
      summary: '古城。',
      stops: [{
        place: place({ id: 'amap:WCG', name: '文昌阁', address: '扬州市广陵区文昌中路' }),
        category: 'sight',
        suggestedStartTime: '10:00',
        suggestedDurationMinutes: 30,
        reason: '地标。',
        sourceQuery: '文昌阁',
      }],
    }],
  };
  const snapshot = structuredClone(plan);
  const next = applyResolvedTripStopDurations(plan, { destination: '扬州', pace: 'balanced' });
  assert.deepEqual(plan, snapshot);
  assert.equal(next.days[0].stops[0].suggestedDurationMinutes, 120);
  assert.equal('source' in next.days[0].stops[0], false);
  assert.equal(JSON.stringify(next).includes('SCALE_HINT'), false);
  assert.equal(JSON.stringify(next).includes('AI_IN_RANGE'), false);
});

test('frontend and BFF sources do not expose duration decision internals or secrets', () => {
  const forbidden = [
    'PLACE_NAME_RULE',
    'PLACE_ID_RULE',
    'SCALE_HINT',
    'PACE_ADJUSTED',
    'AI_IN_RANGE',
    'UNKNOWN_DEFAULT',
    'DASHSCOPE_API_KEY',
    'AMAP_WEB_SERVICE_KEY',
    'qwen3.7-plus',
    'dashscope.aliyuncs.com',
    'json_schema',
  ];
  const files = [
    'src/pages/TripDetailPage.tsx',
    'src/services/bff-trip-generation-service.ts',
    'src/services/bff-client.ts',
    'server/routes/trip-generate.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} ${token}`);
    }
  }
  const srcRoot = join(process.cwd(), 'src');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
  for (const file of walk(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('PLACE_NAME_RULE'), false, file);
    assert.equal(source.includes('userExplicitDurationMinutes'), false, file);
  }
});
