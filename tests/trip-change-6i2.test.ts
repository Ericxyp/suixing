import assert from 'node:assert/strict';
import test from 'node:test';
import type { TripChangeContext, TripChangeIntent } from '../server/services/trip-change-intent-extractor';
import {
  closeAssistant,
  createAssistantUiState,
  discardAssistantPlaceContext,
  showChoices,
} from '../src/services/trip-assistant-session';
import {
  extractSourceReference,
  refineTripChangeIntent,
} from '../server/services/trip-change-intent-refine';

const clarifyIntent: TripChangeIntent = {
  status: 'needs_clarification',
  summary: '请提供具体替换成哪个地点名称。',
  operations: [],
};

const beijingContext: TripChangeContext = {
  tripId: 'trip-beijing',
  destination: '北京',
  days: [{
    dayNumber: 1,
    stops: [
      { tripPlaceId: 'bj-hotel', placeName: '北京饭店', type: 'hotel', startTime: '09:00' },
      { tripPlaceId: 'bj-tiananmen', placeName: '天安门', type: 'attraction', startTime: '10:00' },
      { tripPlaceId: 'bj-temple', placeName: '天坛公园', type: 'attraction', startTime: '13:00' },
      { tripPlaceId: 'bj-square', placeName: '天安门广场', type: 'attraction', startTime: '15:00' },
      { tripPlaceId: 'bj-lunch', placeName: '陈记卤煮小肠', type: 'restaurant', startTime: '12:00' },
    ],
  }],
};

const shanghaiContext: TripChangeContext = {
  tripId: 'trip-shanghai',
  destination: '上海',
  days: [{
    dayNumber: 1,
    stops: [
      { tripPlaceId: 'tp-d1-hotel', placeName: '上海外滩英迪格酒店', type: 'hotel', startTime: '09:00' },
      { tripPlaceId: 'tp-d1-wukang', placeName: '武康路', type: 'attraction', startTime: '10:30' },
      { tripPlaceId: 'tp-d1-xintiandi', placeName: '新天地', type: 'shopping', startTime: '18:30' },
    ],
  }, {
    dayNumber: 2,
    stops: [
      { tripPlaceId: 'tp-d2-museum', placeName: '上海博物馆', type: 'attraction', startTime: '10:00' },
    ],
  }],
};

test('extracts 新天地 from unpunctuated 想去别的商场', () => {
  assert.equal(extractSourceReference('不想去新天地想去别的商场'), '新天地');
});

test('Beijing day without 新天地 does not dump every stop or search malls', () => {
  const refined = refineTripChangeIntent(
    '不想去新天地想去别的商场',
    beijingContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.sourceGrounding, 'NOT_IN_TRIP');
  assert.equal(refined.intentType, 'CLARIFY');
  assert.equal(refined.publicIntent.status, 'needs_clarification');
  assert.equal(refined.publicIntent.summary.includes('当前行程中没有“新天地”'), true);
  assert.equal(refined.sourceStop, undefined);
  const names = (refined.publicIntent.sourceChoices ?? []).map((item) => item.placeName);
  assert.equal(names.includes('陈记卤煮小肠'), false);
  assert.equal(names.includes('北京饭店'), false);
  assert.equal(names.length <= 3, true);
  assert.equal(names.includes('天安门'), true);
});

test('same sentence on Shanghai day with 新天地 is category replace', () => {
  const refined = refineTripChangeIntent(
    '不想去新天地想去别的商场',
    shanghaiContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.sourceGrounding, 'RESOLVED');
  assert.equal(refined.intentType, 'REPLACE_WITH_CATEGORY');
  assert.equal(refined.sourceStop?.tripPlaceId, 'tp-d1-xintiandi');
  assert.equal(refined.targetCategory, 'shopping');
  assert.equal(refined.publicIntent.status, 'needs_choice');
});

test('place on another day is NOT_IN_CURRENT_DAY and does not use that stop', () => {
  const refined = refineTripChangeIntent(
    '不想去上海博物馆换一个公园',
    shanghaiContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.sourceGrounding, 'NOT_IN_CURRENT_DAY');
  assert.equal(refined.publicIntent.summary.includes('当前 Day 1 中没有“上海博物馆”'), true);
  assert.equal(refined.sourceStop, undefined);
});

test('ordinary clarify lists sightseeing only', () => {
  const refined = refineTripChangeIntent(
    '换一个地点',
    beijingContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.sourceGrounding, 'AMBIGUOUS');
  const names = (refined.publicIntent.sourceChoices ?? []).map((item) => item.placeName);
  assert.equal(names.includes('陈记卤煮小肠'), false);
  assert.equal(names.includes('北京饭店'), false);
  assert.equal(names.length <= 3, true);
});

test('explicit lunch replace can use a restaurant source', () => {
  const refined = refineTripChangeIntent(
    '换午餐餐厅',
    beijingContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.sourceStop?.tripPlaceId, 'bj-lunch');
  assert.equal(refined.sourceGrounding, 'RESOLVED');
});

test('closing ask suixing drops place session context', () => {
  const open = showChoices(
    { ...createAssistantUiState(), open: true, sessionHint: { selectedDayNumber: 1, sourceTripPlaceId: 'tp-d1-xintiandi' } },
    '候选',
    [{ placeId: 'mall-1', name: '兴业太古汇', categoryLabel: '购物', relation: '在「新天地」附近' }],
    { dayNumber: 1, targetTripPlaceId: 'tp-d1-xintiandi' },
  );
  const closed = closeAssistant(open);
  assert.equal(closed.sessionHint, null);
  assert.equal(closed.candidates.length, 0);
  const switched = discardAssistantPlaceContext(open);
  assert.equal(switched.sessionHint, null);
  assert.equal(switched.pendingReplace, null);
});

test('exact place replace still resolves when the source exists today', () => {
  const refined = refineTripChangeIntent(
    '把新天地换成颐和园',
    shanghaiContext,
    {
      status: 'ready',
      summary: '将新天地换成颐和园。',
      operations: [{
        type: 'REPLACE_PLACE',
        dayNumber: 1,
        targetTripPlaceId: 'tp-d1-xintiandi',
        replacementQuery: '颐和园',
      }],
    },
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.intentType, 'REPLACE_WITH_EXACT_PLACE');
  assert.equal(refined.sourceGrounding, 'RESOLVED');
  assert.equal(refined.publicIntent.status, 'ready');
});
