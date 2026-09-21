import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Place } from '../src/domain/trip/types';
import { mockShanghaiTrip } from '../src/mocks/trips';
import {
  beginInterpret,
  closeAssistant,
  createAssistantUiState,
  markFailed,
  restoreFailedDraft,
  showChoices,
} from '../src/services/trip-assistant-session';
import { parseTripChangeIntentPayload } from '../src/services/bff-trip-change-service';
import {
  evaluateTripPlaceEligibility,
} from '../server/services/trip-place-eligibility';
import {
  emptyNearbyChoiceSummary,
  refineTripChangeIntent,
} from '../server/services/trip-change-intent-refine';
import { searchNearbyChangeOptions } from '../server/services/trip-change-nearby-options';
import type { TripChangeContext, TripChangeIntent } from '../server/services/trip-change-intent-extractor';

const shanghaiContext: TripChangeContext = {
  tripId: mockShanghaiTrip.id,
  destination: '上海',
  days: [{
    dayNumber: 1,
    stops: [
      { tripPlaceId: 'tp-d1-hotel', placeName: '上海外滩英迪格酒店', type: 'hotel', startTime: '09:00' },
      { tripPlaceId: 'tp-d1-wukang', placeName: '武康路', type: 'attraction', startTime: '10:30' },
      { tripPlaceId: 'tp-d1-xintiandi', placeName: '新天地', type: 'shopping', startTime: '18:30' },
    ],
  }],
};

const clarifyIntent: TripChangeIntent = {
  status: 'needs_clarification',
  summary: '请提供具体替换成哪个地点名称。',
  operations: [],
};

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name' | 'category'>): Place {
  return {
    provider: 'mock',
    providerPlaceId: overrides.id,
    address: '上海市',
    latitude: 31.22,
    longitude: 121.47,
    ...overrides,
  };
}

test('composer clears after send and keeps history; restore works after failure', () => {
  const sent = beginInterpret(createAssistantUiState(), '不想去新天地，换一个商场');
  assert.equal(sent.draft, '');
  assert.equal(sent.messages.some((item) => item.role === 'user' && item.content.includes('新天地')), true);
  const failed = markFailed(sent, '暂时无法调整行程，请稍后重试。');
  assert.equal(failed.draft, '');
  assert.equal(failed.error, '暂时无法调整行程，请稍后重试。');
  assert.equal(failed.statusText, '这次没有改行程。');
  assert.equal(failed.messages.some((item) => item.content === failed.error), false);
  const restored = restoreFailedDraft(failed);
  assert.equal(restored.draft, '不想去新天地，换一个商场');
  const closed = closeAssistant(failed);
  assert.equal(closed.messages.length, 0);
  assert.equal(closed.candidates.length, 0);
  assert.equal(closed.pendingRestoreText, null);
  assert.equal(closed.error, null);
  assert.equal(JSON.stringify(closed).includes('intentType'), false);
});

test('natural mall phrases resolve to category replace of 新天地', () => {
  const phrases = [
    '不想去新天地想去别的商场',
    '不想去新天地换一个商场',
    '不想去新天地，换个别的商场',
    '不去新天地了，换一个商场',
    '把新天地换成附近商场',
    '新天地换个商场',
    '换成其他商场',
    '换一个适合逛街的地方',
  ];
  for (const phrase of phrases) {
    const refined = refineTripChangeIntent(
      phrase,
      shanghaiContext,
      clarifyIntent,
      { selectedDayNumber: 1 },
    );
    assert.equal(refined.intentType, 'REPLACE_WITH_CATEGORY', phrase);
    assert.equal(refined.publicIntent.status, 'needs_choice', phrase);
    assert.equal(refined.sourceStop?.tripPlaceId, 'tp-d1-xintiandi', phrase);
    assert.equal(refined.publicIntent.operations.length, 0, phrase);
  }
});

test('empty nearby malls explain the source instead of 无法理解', () => {
  const summary = emptyNearbyChoiceSummary('新天地', '商场');
  assert.equal(summary.includes('新天地附近暂时没有找到合适的商场选择'), true);
  assert.equal(summary.includes('无法理解'), false);
});

test('nearby malls discover does not mutate trip and keeps the source', () => {
  const refined = refineTripChangeIntent(
    '给我几个附近商场',
    shanghaiContext,
    clarifyIntent,
    { selectedDayNumber: 1, sourceTripPlaceId: 'tp-d1-xintiandi' },
  );
  assert.equal(refined.intentType, 'DISCOVER_NEARBY_OPTIONS');
  assert.equal(refined.publicIntent.status, 'needs_choice');
  assert.equal(refined.publicIntent.operations.length, 0);
});

test('ambiguous day sources ask with real place names', () => {
  const refined = refineTripChangeIntent(
    '换一个博物馆',
    shanghaiContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.intentType, 'CLARIFY');
  assert.equal(refined.publicIntent.summary.includes('新天地'), true);
  assert.equal(refined.publicIntent.summary.includes('武康路'), true);
  assert.equal(refined.publicIntent.summary.includes('具体名称'), false);
});

test('exact replace still auto-applies', () => {
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
  assert.equal(refined.publicIntent.status, 'ready');
});

test('eligible malls can be user replace targets but stay out of core fill', () => {
  const mall = place({ id: 'mall-1', name: '兴业太古汇', category: 'shopping' });
  const parking = place({ id: 'park-1', name: '新天地停车场', category: 'attraction' });
  const suggestion = {
    name: '商场',
    query: '新天地附近商场',
    category: 'shopping' as const,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '行程修改候选地点。',
  };
  assert.equal(evaluateTripPlaceEligibility(mall, suggestion).eligible, true);
  assert.equal(evaluateTripPlaceEligibility(parking, suggestion).eligible, false);
  const core = readFileSync('server/services/trip-core-place-completion-resolver.ts', 'utf8');
  assert.equal(core.includes("place.category === 'shopping'"), true);
});

test('nearby search filters ineligible POIs and stays deterministic', async () => {
  const queries: string[] = [];
  const first = await searchNearbyChangeOptions({
    city: '上海',
    sourceName: '新天地',
    nextName: undefined,
    category: 'shopping',
    query: '商场',
    excludePlaceNames: ['新天地'],
    placeSearch: {
      async search(input) {
        queries.push(input.query);
        return [
          place({ id: 'place-xintiandi', name: '新天地', category: 'shopping' }),
          place({ id: 'b-mall', name: '新天地时尚购物中心', category: 'shopping' }),
          place({ id: 'a-mall', name: '兴业太古汇', category: 'shopping' }),
          place({ id: 'metro', name: '新天地地铁站', category: 'transport' }),
        ];
      },
    },
  });
  const second = await searchNearbyChangeOptions({
    city: '上海',
    sourceName: '新天地',
    category: 'shopping',
    query: '商场',
    placeSearch: {
      async search() {
        return [
          place({ id: 'metro', name: '新天地地铁站', category: 'transport' }),
          place({ id: 'a-mall', name: '兴业太古汇', category: 'shopping' }),
          place({ id: 'b-mall', name: '新天地时尚购物中心', category: 'shopping' }),
        ];
      },
    },
  });
  assert.deepEqual(first.map((item) => item.name), ['兴业太古汇', '新天地时尚购物中心']);
  assert.equal(first.some((item) => item.name === '新天地'), false);
  assert.equal(queries[0], '新天地附近 商场');
  assert.deepEqual(second.map((item) => item.placeId), first.map((item) => item.placeId));
  assert.equal(first.some((item) => item.name.includes('地铁')), false);
  assert.equal(first[0]?.relation.includes('新天地'), true);
  assert.equal(JSON.stringify(first).includes('intentType'), false);
  assert.equal(JSON.stringify(first).includes('prompt'), false);
});

test('public choice payload rejects internal fields and keeps apply pending', () => {
  const intent = parseTripChangeIntentPayload({
    data: {
      intent: {
        status: 'needs_choice',
        summary: '新天地可以换成这些顺路的商场：',
        operations: [],
        pendingReplace: { dayNumber: 1, targetTripPlaceId: 'tp-d1-xintiandi' },
        candidates: [{
          placeId: 'a-mall',
          name: '兴业太古汇',
          categoryLabel: '购物',
          relation: '在「新天地」附近',
        }],
      },
    },
  });
  assert.equal(intent.status, 'needs_choice');
  const ui = showChoices(
    beginInterpret(createAssistantUiState(), '不想去新天地，换一个商场'),
    intent.summary,
    intent.candidates ?? [],
    intent.pendingReplace,
  );
  assert.equal(ui.phase, 'needs_choice');
  assert.equal(ui.pendingReplace?.targetTripPlaceId, 'tp-d1-xintiandi');
  assert.throws(() => parseTripChangeIntentPayload({
    data: {
      intent: {
        status: 'needs_choice',
        summary: '候选',
        operations: [],
        intentType: 'REPLACE_WITH_CATEGORY',
        candidates: [{
          placeId: 'a-mall',
          name: '兴业太古汇',
          categoryLabel: '购物',
          relation: '在「新天地」附近',
        }],
      },
    },
  }));
});

test('two visitable stops without a named source still clarify museums', () => {
  const refined = refineTripChangeIntent(
    '换一个博物馆',
    shanghaiContext,
    clarifyIntent,
    { selectedDayNumber: 1 },
  );
  assert.equal(refined.intentType, 'CLARIFY');
});

test('session is not written to localStorage helpers', () => {
  const session = readFileSync('src/services/trip-assistant-session.ts', 'utf8');
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  assert.equal(session.includes('localStorage'), false);
  assert.equal(workspace.includes('assistant') && workspace.includes('localStorage'), false);
  assert.equal(workspace.includes('handleSelectCandidate'), true);
});

