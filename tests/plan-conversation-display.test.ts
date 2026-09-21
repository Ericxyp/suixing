import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { TripRequirementDraft } from '../src/domain/trip/ai';
import {
  PLAN_EMPTY_GUIDE,
  PLAN_EXTRACTING_STATUS,
  PLAN_HERO_EYEBROW,
  PLAN_HERO_TITLE_EMPTY,
  planHeaderStatus,
  planHeroSubtitle,
  planHeroTitle,
  planSummaryPeek,
  tripContextChips,
} from '../src/services/plan-conversation-display';
import { PLAN_GENERATING_MESSAGE } from '../src/services/plan-conversation-service';
import { deserializePlanConversation, serializePlanConversation } from '../src/services/plan-conversation-store';
import { createEmptyPlanConversation, appendUserMessage } from '../src/services/plan-conversation-service';

const completeDraft: TripRequirementDraft = {
  destination: '上海',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
};

test('hero copy follows real destination and missing fields', () => {
  assert.equal(planHeroTitle({}), PLAN_HERO_TITLE_EMPTY);
  assert.equal(planHeroTitle({ destination: '杭州' }), '正在规划 杭州');
  assert.equal(planHeroSubtitle({}), '还差目的地、日期、人数和预算');
  assert.equal(planHeroSubtitle({ destination: '上海', travelerCount: 2 }), '还差日期和预算');
  assert.equal(planHeroSubtitle(completeDraft), '旅行信息已齐全，正在据此安排行程。');
  assert.equal(PLAN_HERO_EYEBROW, '规划你的下一段旅程');
  assert.equal(PLAN_EXTRACTING_STATUS, '正在整理旅行信息…');
  assert.match(PLAN_EMPTY_GUIDE, /说说你想去哪/);
});

test('header status only appears for real extracting, generating or complete states', () => {
  assert.equal(planHeaderStatus({ extracting: false, generationStatus: 'collecting', ready: false }), undefined);
  assert.equal(planHeaderStatus({ extracting: true, generationStatus: 'collecting', ready: false }), '整理中');
  assert.equal(planHeaderStatus({ extracting: false, generationStatus: 'generating', ready: true }), '安排中');
  assert.equal(planHeaderStatus({ extracting: false, generationStatus: 'ready', ready: true }), '旅行信息');
});

test('trip context chips stay human-readable and omit empty or long-term profile data', () => {
  assert.deepEqual(tripContextChips({}), []);
  assert.deepEqual(tripContextChips({
    longTermProfileSignals: {
      coffee: { value: 0.9, confidence: 0.8, source: 'explicit' },
    },
  }), []);
  assert.deepEqual(tripContextChips({
    tripIntent: { interestKeys: ['history', 'culture_art'] },
    constraints: { excludedInterestKeys: ['shopping'] },
  }), ['历史文化优先', '不安排购物']);
  assert.deepEqual(tripContextChips({
    partyContext: { partyType: 'parents', hasElderly: true, mobilityRequirement: 'low_walking' },
    constraints: { excludedInterestKeys: [], lowWalking: true },
    tripIntent: { interestKeys: [], pace: 'relaxed' },
  }), ['带父母 · 少走路', '轻松节奏']);
  assert.equal(JSON.stringify(tripContextChips({
    tripIntent: { interestKeys: ['coffee'] },
  })).includes('confidence'), false);
});

test('summary peek shows filled facts and remaining gaps', () => {
  assert.equal(planSummaryPeek({}), '还差目的地、日期、人数和预算');
  assert.match(planSummaryPeek({ destination: '上海', durationDays: 3 }), /上海/);
  assert.match(planSummaryPeek({ destination: '上海', durationDays: 3 }), /还差/);
  assert.match(planSummaryPeek(completeDraft), /上海/);
  assert.equal(planSummaryPeek(completeDraft).includes('还差'), false);
});

test('plan page keeps a single TravelSummary and existing generate flow', () => {
  const page = readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8');
  const conversation = readFileSync(join(process.cwd(), 'src/components/plan/PlanConversation.tsx'), 'utf8');
  const summary = readFileSync(join(process.cwd(), 'src/components/plan/TravelSummary.tsx'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8');
  const display = readFileSync(join(process.cwd(), 'src/services/plan-conversation-display.ts'), 'utf8');

  assert.equal(page.split('<TravelSummary').length - 1, 1);
  assert.match(page, /plan-hero/);
  assert.match(page, /plan-summary-rail/);
  assert.match(page, /creationFingerprint/);
  assert.match(page, /runPlanTripCreate/);
  assert.match(page, /applySummaryDraftUpdate/);
  assert.equal(page.includes('window.innerWidth'), false);
  assert.equal(page.includes('生成旅行方案'), false);

  assert.match(conversation, /PLAN_GENERATION_FAILED_MESSAGE/);
  assert.match(conversation, /generationStatus === 'failed'/);
  assert.match(conversation, /PLAN_EXTRACTING_STATUS/);
  assert.match(conversation, /PLAN_GENERATING_MESSAGE/);
  assert.equal(PLAN_GENERATING_MESSAGE, '旅行信息已齐全，正在为你安排行程…');

  assert.match(summary, /基础信息/);
  assert.match(summary, /旅行方式/);
  assert.match(summary, /本次同行与约束/);
  assert.match(summary, /修改/);
  assert.match(summary, /待补充/);
  assert.equal(summary.includes('confidence'), false);
  assert.equal(summary.includes('longTermProfileSignals'), false);

  assert.match(css, /minmax\(0, 1\.5fr\) minmax\(280px, 1fr\)/);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /@media \(max-width: 899px\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /min-height: 44px/);
  assert.equal(css.includes('travel-summary-desktop'), false);

  assert.equal(display.includes('你是咖啡控'), false);
  assert.equal(page.includes('qwen'), false);
  assert.equal(page.includes('sk-'), false);
  assert.equal(conversation.includes('prompt'), false);
});

test('old conversation store payloads still restore after the visual refresh', () => {
  const started = appendUserMessage(createEmptyPlanConversation(), '去杭州');
  const parsed = deserializePlanConversation(serializePlanConversation(started));
  assert.equal(parsed?.messages[0]?.content, '去杭州');
  assert.deepEqual(parsed?.draft, {});
});
