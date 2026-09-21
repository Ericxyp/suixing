import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { TripRequirementDraft } from '../src/domain/trip/ai';
import { USER_TRAVEL_PROFILE_STORAGE_KEY } from '../src/domain/trip/profile';
import { buildPlanningPolicyV1 } from '../src/services/travel-profile-policy';
import {
  applyTripStyleDraftUpdate,
  createEmptyPlanConversation,
} from '../src/services/plan-conversation-service';
import {
  applyTripStyleToRequirementDraft,
  buildTripStyleViewV1,
  TRIP_STYLE_EMPTY_COPY,
  TRIP_STYLE_FOOTNOTE,
} from '../src/services/trip-style-display';

test('history coffee parents and low walking render Chinese labels without internals', () => {
  const view = buildTripStyleViewV1({
    tripIntent: { interestKeys: ['history', 'coffee'], pace: 'relaxed' },
    partyContext: { partyType: 'parents', mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  });
  assert.equal(view.visible, true);
  assert.deepEqual(view.interestLabels, ['历史文化', '咖啡休息']);
  assert.deepEqual(view.companionLabels, ['带父母同行', '少走路']);
  assert.equal(view.paceLabel, '轻松节奏');
  assert.equal(JSON.stringify(view).includes('history'), false);
  assert.equal(JSON.stringify(view).includes('confidence'), false);
  assert.equal(JSON.stringify(view).includes('0.6'), false);
  assert.match(TRIP_STYLE_FOOTNOTE, /本次偏好会优先于长期习惯/);
});

test('missing style facts stay at a neutral balanced copy', () => {
  const view = buildTripStyleViewV1({});
  assert.equal(view.visible, false);
  const ready = buildTripStyleViewV1({
    destination: '上海',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    travelerCount: 2,
    totalBudget: 5000,
  });
  assert.equal(ready.visible, true);
  assert.equal(ready.empty, true);
  assert.deepEqual(ready.interestLabels, []);
  assert.equal(ready.paceLabel, '均衡节奏');
  assert.equal(TRIP_STYLE_EMPTY_COPY.includes('历史文化'), false);
});

test('excluded shopping is shown as an avoid label and not as a preference', () => {
  const view = buildTripStyleViewV1({
    tripIntent: { interestKeys: ['shopping', 'coffee'] },
    constraints: { excludedInterestKeys: ['shopping'] },
  });
  assert.deepEqual(view.interestLabels, ['咖啡休息']);
  assert.deepEqual(view.avoidLabels, ['不安排购物']);
  assert.equal(view.interestLabels.includes('购物'), false);
});

test('long-term explicit profile is a light hint and ignores inferred signals', () => {
  const view = buildTripStyleViewV1({
    tripIntent: { interestKeys: ['history'] },
    constraints: { excludedInterestKeys: ['shopping'] },
    longTermProfileSignals: {
      coffee: { value: 0.9, confidence: 0.8, source: 'explicit' },
      architecture: { value: 0.7, confidence: 0.8, source: 'explicit' },
      nature: { value: 0.95, confidence: 0.9, source: 'inferred' },
      photography: { value: 0.9, confidence: 0.8, source: 'behavioral' },
      shopping: { value: 0.99, confidence: 0.9, source: 'explicit' },
      history: { value: 0.9, confidence: 0.9, source: 'explicit' },
    },
  });
  assert.equal(view.longTermHint, '你常关注：咖啡休息、建筑');
  assert.equal(view.longTermHint?.includes('自然'), false);
});

test('editing this trip style updates draft fields without touching long-term storage', () => {
  const before = globalThis.localStorage?.getItem?.(USER_TRAVEL_PROFILE_STORAGE_KEY) ?? null;
  const draft: TripRequirementDraft = {
    destination: '北京',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    travelerCount: 3,
    totalBudget: 8000,
    longTermProfileSignals: {
      coffee: { value: 0.9, confidence: 0.8, source: 'explicit' },
    },
  };
  const session = applyTripStyleDraftUpdate(createEmptyPlanConversation(), draft);
  session.messages.push({
    id: 'm1',
    role: 'user',
    content: '去北京',
    createdAt: '2026-09-16T00:00:00.000Z',
  });
  const nextDraft = applyTripStyleToRequirementDraft(draft, {
    interestKeys: ['history', 'coffee', 'nature', 'food'],
    pace: 'relaxed',
    partyType: 'parents',
    lowWalking: true,
    excludedInterestKeys: ['shopping'],
  });
  const next = applyTripStyleDraftUpdate(session, nextDraft);
  assert.deepEqual(next.draft.tripIntent?.interestKeys, ['history', 'coffee', 'nature']);
  assert.equal(next.draft.tripIntent?.pace, 'relaxed');
  assert.equal(next.draft.partyContext?.partyType, 'parents');
  assert.equal(next.draft.constraints?.lowWalking, true);
  assert.deepEqual(next.draft.constraints?.excludedInterestKeys, ['shopping']);
  assert.equal(next.draft.destination, '北京');
  assert.equal(next.draft.travelerCount, 3);
  assert.equal(next.draft.totalBudget, 8000);
  assert.equal(next.messages[0]?.content, '去北京');
  assert.equal(next.draft.longTermProfileSignals?.coffee?.source, 'explicit');
  assert.equal(globalThis.localStorage?.getItem?.(USER_TRAVEL_PROFILE_STORAGE_KEY) ?? null, before);
});

test('saved style is readable by planning policy for a two-core parents day', () => {
  const draft = applyTripStyleToRequirementDraft({
    destination: '北京',
    pace: 'balanced',
  }, {
    interestKeys: ['history'],
    pace: 'balanced',
    partyType: 'parents',
    lowWalking: true,
    excludedInterestKeys: [],
  });
  const policy = buildPlanningPolicyV1({
    tripIntent: draft.tripIntent,
    partyContext: draft.partyContext,
    constraints: draft.constraints,
    tripPace: draft.pace,
  });
  assert.equal(policy.targetCorePlacesPerDay, 2);
  assert.deepEqual(policy.preferredInterestKeys, ['history']);
});

test('old drafts and missing profile stay in a safe empty style state', () => {
  assert.doesNotThrow(() => buildTripStyleViewV1({}));
  assert.doesNotThrow(() => buildTripStyleViewV1({
    longTermProfileSignals: undefined,
  }));
  const view = buildTripStyleViewV1({
    longTermProfileSignals: {
      coffee: { value: Number.NaN, confidence: 1, source: 'explicit' },
    } as TripRequirementDraft['longTermProfileSignals'],
  });
  assert.equal(view.longTermHint, undefined);
});

test('style card copy stays off scores policy and prompts', () => {
  const files = [
    readFileSync(join(process.cwd(), 'src/services/trip-style-display.ts'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/components/plan/TripStyleSummaryCard.tsx'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/components/plan/TripStyleEditor.tsx'), 'utf8'),
  ].join('\n');
  assert.equal(files.includes('你被判定为'), false);
  assert.equal(files.includes('AI 推断'), false);
  assert.equal(files.includes('targetCorePlacesPerDay'), false);
  assert.equal(files.includes('qwen'), false);
});
