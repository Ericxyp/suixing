import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Place, TripScheduleItem } from '../src/domain/trip/types';
import {
  MEAL_APPLY_FAILED_NOTICE,
  MEAL_OPTIONS_EMPTY_COPY,
  MEAL_OPTIONS_EMPTY_TITLE,
  mealOptionRouteCopy,
  mealOptionsContext,
  mealOptionsHeading,
  mealOptionTypeLabel,
} from '../src/services/meal-options-display';

const slot: Extract<TripScheduleItem, { kind: 'meal_slot' }> = {
  kind: 'meal_slot',
  id: 'slot-1',
  mealPeriod: 'lunch',
  startTime: '12:15',
  durationMinutes: 75,
  areaTripPlaceId: 'stop-area',
  nextTripPlaceId: 'stop-next',
  diningMode: 'flexible',
};

const restaurant: Place = {
  id: 'amap:R1',
  name: '陈记卤煮小肠',
  provider: 'amap',
  providerPlaceId: 'R1',
  address: '北京市',
  latitude: 39.9,
  longitude: 116.4,
  category: 'restaurant',
};

test('picker copy uses real meal slot context and Chinese type labels', () => {
  assert.equal(mealOptionsHeading(slot, '天安门'), '午餐 · 天安门');
  assert.equal(mealOptionsContext(slot, '天安门', '天坛公园'), '预留 1h15min · 位于天安门与天坛公园之间');
  assert.equal(mealOptionTypeLabel('restaurant'), '餐厅');
  assert.equal(mealOptionTypeLabel('cafe'), '咖啡休息');
  assert.equal(mealOptionRouteCopy(restaurant, '天坛公园'), '顺路前往天坛公园');
  assert.equal(MEAL_OPTIONS_EMPTY_TITLE, '暂时没找到合适的餐饮选择');
  assert.equal(MEAL_OPTIONS_EMPTY_COPY, '你可以保留这段用餐时间，或稍后再试。');
  assert.equal(MEAL_APPLY_FAILED_NOTICE, '暂时无法加入这家餐厅，请稍后重试。');
});

test('flexible meal slots expose picker; self_managed and meal_place do not', () => {
  const timeline = readFileSync('src/components/trip/ItineraryTimeline.tsx', 'utf8');
  const mealSlotBlock = timeline.slice(
    timeline.indexOf("item.kind === 'meal_slot'"),
    timeline.indexOf('const place = placeById.get(item.tripPlaceId)'),
  );
  assert.equal(mealSlotBlock.includes("diningMode === 'flexible'"), true);
  assert.equal(mealSlotBlock.includes('看看吃什么'), true);
  assert.equal(mealSlotBlock.includes('self_managed'), false);
  assert.equal(timeline.includes("item.kind === 'meal_place'"), true);
  const mealPlaceBlock = timeline.slice(timeline.indexOf("const mealLabel"));
  assert.equal(mealPlaceBlock.includes('看看吃什么'), false);
});

test('workspace mounts one meal sheet and reuses list, apply, save, undo paths', () => {
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  assert.equal(workspace.split('<MealOptionsSheet').length - 1, 1);
  assert.equal(workspace.includes('ask-suixing-sheet--side meal-options-sheet'), false);
  assert.equal(workspace.includes('mealService.listOptions'), true);
  assert.equal(workspace.includes("category === 'coffee'"), true);
  assert.equal(workspace.includes('mealService.apply'), true);
  assert.equal(workspace.includes('onCommitChange'), true);
  assert.equal(workspace.includes('previous'), true);
  assert.equal(workspace.includes('applyingPlaceId: placeId'), true);
  assert.equal(workspace.includes('mealSheet.places.some'), true);
  assert.equal(workspace.includes('places: [...places]'), true);
  assert.equal(workspace.includes('MEAL_APPLY_FAILED_NOTICE'), true);
  assert.equal(workspace.includes('INVALID_TWO_PLACE_DAY'), false);
  assert.equal(workspace.includes('MISSING_CORE_PLACES'), false);
  assert.equal(workspace.includes("status: 'error'"), true);
  assert.equal(workspace.includes('setMealSheet(null)'), true);
});

test('meal options sheet shows real fields, loading skeletons, and per-item apply', () => {
  const sheet = readFileSync('src/components/trip/MealOptionsSheet.tsx', 'utf8');
  assert.equal(sheet.includes('用餐安排'), true);
  assert.equal(sheet.includes('mealOptionsHeading'), true);
  assert.equal(sheet.includes('mealOptionTypeLabel'), true);
  assert.equal(sheet.includes('mealOptionRouteCopy'), true);
  assert.equal(sheet.includes('正在加入…'), true);
  assert.equal(sheet.includes('disabled={applying}'), true);
  assert.equal(sheet.includes('meal-option-skeleton'), true);
  assert.equal(sheet.includes('MEAL_OPTIONS_EMPTY_TITLE'), true);
  assert.equal(sheet.includes('评分'), false);
  assert.equal(sheet.includes('网红'), false);
  assert.equal(sheet.includes('人均'), false);
  assert.equal(sheet.includes('营业时间'), false);
  assert.equal(sheet.includes('${s.type}'), false);
  assert.equal(sheet.includes('Escape'), true);
  assert.equal(sheet.includes('aria-label="关闭用餐安排"'), true);
});

test('meal picker css uses travel blue, 900px rail, and one mobile sheet', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  assert.equal(css.includes('.meal-options-layer'), true);
  assert.equal(css.includes('.meal-options-sheet'), true);
  assert.equal((css.match(/\.meal-options-layer/g) || []).length >= 1, true);
  assert.equal(css.includes('width: 460px'), true);
  assert.equal(css.includes('max-width: 500px'), true);
  const mealCss = css.slice(css.indexOf('.meal-options-layer'), css.indexOf('.empty-itinerary'));
  assert.equal(mealCss.includes('@media (min-width: 900px)'), true);
  assert.equal(mealCss.includes('@media (max-width: 899px)'), true);
  assert.equal(mealCss.includes('#3b82f6'), true);
  assert.equal(mealCss.includes('#183b35'), false);
  assert.equal(mealCss.includes('env(safe-area-inset-bottom'), true);
  assert.equal(css.includes('.ask-suixing-entry-slot--mobile'), true);
});
