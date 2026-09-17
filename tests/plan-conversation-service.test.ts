import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequirementExtractionResult } from '../src/domain/trip/ai';
import { BffAiTripService } from '../src/services/bff-ai-trip-service';
import { BffClientError } from '../src/services/bff-client';
import {
  BUDGET_QUESTION,
  DESTINATION_QUESTION,
  MAX_EXTRACTION_INPUT_LENGTH,
  PLAN_COMPLETE_MESSAGE,
  PLAN_CONVERSATION_PATH,
  PLAN_GENERATING_MESSAGE,
  PLAN_GENERATION_FAILED_MESSAGE,
  applyGenerationFailure,
  applyGenerationStarted,
  SCHEDULE_QUESTION,
  TRAVELER_QUESTION,
  appendUserMessage,
  applyExtractionResult,
  applySummaryDraftUpdate,
  buildExtractionInput,
  createEmptyPlanConversation,
  extractPlanRequirements,
  formatSummaryEditIntent,
  getMissingRequirementFields,
  isPlanReadyToGenerate,
  mergeRequirementDrafts,
  nextFollowUpQuestion,
  noticeForRequirementExtractionError,
  parseHomeTripRequest,
  toCreateTripRequirements,
  userUtterances,
} from '../src/services/plan-conversation-service';
import { mockAiTripService } from '../src/services/mock-ai-trip-service';
import {
  createRequirementExtractionService,
  getTripAiMode,
} from '../src/services/trip-requirement-service';

class FakeExtractionService {
  calls: string[] = [];

  constructor(private readonly results: RequirementExtractionResult[]) {}

  async extractRequirements(input: string): Promise<RequirementExtractionResult> {
    this.calls.push(input);
    const next = this.results.shift();
    if (!next) {
      throw new Error('unexpected extraction');
    }
    return structuredClone(next);
  }
}

test('home submit navigates to the plan conversation with the first user text', () => {
  const parsed = parseHomeTripRequest('  想去上海玩几天  ');
  assert.deepEqual(parsed, {
    ok: true,
    path: PLAN_CONVERSATION_PATH,
    state: { initialText: '想去上海玩几天' },
  });
  const started = appendUserMessage(createEmptyPlanConversation(), parsed.ok ? parsed.state.initialText ?? '' : '');
  assert.equal(started.messages[0]?.role, 'user');
  assert.equal(started.messages[0]?.content, '想去上海玩几天');
  assert.equal(parseHomeTripRequest('   ').ok, false);
});

test('asks only for the next missing destination', () => {
  const state = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '两个人出去玩'),
    {
      draft: { travelerCount: 2 },
      missingRequiredFields: [
        { field: 'destination', message: '请补充目的地。' },
        { field: 'durationDays', message: '请补充日期或行程天数。' },
        { field: 'totalBudget', message: '请补充总预算。' },
      ],
    },
  );
  const assistant = state.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.content, DESTINATION_QUESTION);
  assert.equal(nextFollowUpQuestion(state.missingRequiredFields), DESTINATION_QUESTION);
  assert.equal(state.messages.some((message) => message.content === SCHEDULE_QUESTION), false);
});

test('keeps confirmed fields across turns and updates the draft', async () => {
  const service = new FakeExtractionService([
    {
      draft: { destination: '上海', travelerCount: 2 },
      missingRequiredFields: [],
    },
    {
      draft: { durationDays: 3, totalBudget: 5000, pace: 'relaxed' },
      missingRequiredFields: [],
    },
  ]);
  const first = appendUserMessage(createEmptyPlanConversation(), '两个人去上海');
  const afterFirst = applyExtractionResult(first, await extractPlanRequirements(first, service));
  assert.equal(afterFirst.draft.destination, '上海');
  assert.equal(afterFirst.draft.travelerCount, 2);
  assert.equal(nextFollowUpQuestion(afterFirst.missingRequiredFields), SCHEDULE_QUESTION);

  const second = appendUserMessage(afterFirst, '玩 3 天，预算 5000，想轻松一点');
  const afterSecond = applyExtractionResult(second, await extractPlanRequirements(second, service));
  assert.equal(afterSecond.draft.destination, '上海');
  assert.equal(afterSecond.draft.travelerCount, 2);
  assert.equal(afterSecond.draft.durationDays, 3);
  assert.equal(afterSecond.draft.totalBudget, 5000);
  assert.equal(afterSecond.draft.pace, 'relaxed');
  assert.deepEqual(service.calls[1]?.includes('两个人去上海'), true);
  assert.equal(service.calls[1]?.includes(DESTINATION_QUESTION), false);
});

test('shows generating guidance and no follow-up when information is complete', () => {
  const state = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '上海 3 天 2 人 预算 5000'),
    {
      draft: {
        destination: '上海',
        durationDays: 3,
        travelerCount: 2,
        totalBudget: 5000,
      },
      missingRequiredFields: [],
    },
  );
  assert.equal(isPlanReadyToGenerate(state.draft), true);
  assert.equal(nextFollowUpQuestion(state.missingRequiredFields), undefined);
  assert.equal(state.messages.at(-1)?.content, PLAN_COMPLETE_MESSAGE);
  assert.ok(toCreateTripRequirements(state.draft));
  assert.equal(
    state.messages.some((message) => [
      DESTINATION_QUESTION,
      SCHEDULE_QUESTION,
      TRAVELER_QUESTION,
      BUDGET_QUESTION,
    ].includes(message.content)),
    false,
  );
});

test('summary edits update the draft, missing fields, and insert an intent message', () => {
  const started = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '去上海玩 3 天，2 人'),
    {
      draft: { destination: '上海', durationDays: 3, travelerCount: 2 },
      missingRequiredFields: [],
    },
  );
  const nextDraft = { ...started.draft, totalBudget: 4000 };
  const updated = applySummaryDraftUpdate(
    started,
    nextDraft,
    formatSummaryEditIntent('totalBudget', nextDraft),
  );
  assert.equal(updated.draft.destination, '上海');
  assert.equal(updated.draft.totalBudget, 4000);
  assert.equal(isPlanReadyToGenerate(updated.draft), true);
  assert.match(updated.messages.at(-2)?.content ?? '', /将总预算调整为/);
  assert.equal(updated.messages.at(-1)?.content, PLAN_COMPLETE_MESSAGE);

  const incomplete = applySummaryDraftUpdate(
    updated,
    { ...updated.draft, destination: undefined },
    formatSummaryEditIntent('destination', {}),
  );
  assert.equal(incomplete.draft.destination, undefined);
  assert.equal(nextFollowUpQuestion(incomplete.missingRequiredFields), DESTINATION_QUESTION);
  assert.equal(isPlanReadyToGenerate(incomplete.draft), false);
});

test('mock and bff modes share the same extraction abstraction', async () => {
  assert.equal(getTripAiMode(undefined), 'mock');
  assert.equal(createRequirementExtractionService('mock'), mockAiTripService);
  assert.equal(createRequirementExtractionService(getTripAiMode('bff')) instanceof BffAiTripService, true);

  const mockResult = await mockAiTripService.extractRequirements('国庆去上海 3 天，两个人，预算 4000，喜欢咖啡');
  const viaFactory = createRequirementExtractionService('mock');
  const started = appendUserMessage(createEmptyPlanConversation(), '国庆去上海 3 天，两个人，预算 4000，喜欢咖啡');
  const advanced = applyExtractionResult(started, await extractPlanRequirements(started, viaFactory));
  assert.equal(advanced.draft.destination, mockResult.draft.destination);
  assert.equal(advanced.draft.totalBudget, 4000);
});

test('BFF failures stay in Chinese, keep the session, and do not fall back to mock', async () => {
  const failing = {
    async extractRequirements() {
      throw new BffClientError('AI_PROVIDER_UNAVAILABLE', '智能服务尚未配置。');
    },
  };
  const started = appendUserMessage(createEmptyPlanConversation(), '想去上海');
  await assert.rejects(
    () => extractPlanRequirements(started, failing),
    (error: unknown) => {
      assert.equal(
        noticeForRequirementExtractionError(error),
        '智能服务尚未配置，请稍后再试。',
      );
      return true;
    },
  );
  assert.equal(started.messages[0]?.content, '想去上海');
  assert.equal(started.draft.destination, undefined);
  assert.equal(
    noticeForRequirementExtractionError(new BffClientError('NETWORK_ERROR', '网络异常，请稍后重试。')),
    '暂时无法整理旅行需求，请重试。',
  );
});

test('extraction context contains only user utterances and stays within the input limit', () => {
  let state = createEmptyPlanConversation();
  state = appendUserMessage(state, '去上海');
  state = applyExtractionResult(state, {
    draft: { destination: '上海' },
    missingRequiredFields: getMissingRequirementFields({ destination: '上海' }),
  });
  state = appendUserMessage(state, 'a'.repeat(1800));
  const input = buildExtractionInput(state.messages);
  assert.equal(input.includes(DESTINATION_QUESTION), false);
  assert.equal(userUtterances(state.messages).every((line) => input.includes(line.slice(-20)) || line.length > MAX_EXTRACTION_INPUT_LENGTH || input.length <= MAX_EXTRACTION_INPUT_LENGTH), true);
  assert.ok(input.length <= MAX_EXTRACTION_INPUT_LENGTH);
});

test('merge prefers newly extracted values without dropping earlier fields', () => {
  const merged = mergeRequirementDrafts(
    { destination: '上海', origin: '北京', travelerCount: 2, preferences: { interests: ['咖啡'] } },
    { totalBudget: 4000, preferences: { interests: ['建筑'] } },
  );
  assert.equal(merged.destination, '上海');
  assert.equal(merged.origin, '北京');
  assert.equal(merged.travelerCount, 2);
  assert.equal(merged.totalBudget, 4000);
  assert.deepEqual(merged.preferences?.interests, ['咖啡', '建筑']);
});

test('generation failure replaces the in-progress assistant message', () => {
  const started = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '北京玩三天，3 人，预算 3000'),
    {
      draft: {
        destination: '北京',
        durationDays: 3,
        travelerCount: 3,
        totalBudget: 3000,
      },
      missingRequiredFields: [],
    },
  );
  assert.equal(started.messages.at(-1)?.content, PLAN_GENERATING_MESSAGE);
  const failed = applyGenerationFailure(started);
  assert.equal(failed.messages.at(-1)?.content, PLAN_GENERATION_FAILED_MESSAGE);
  assert.equal(failed.messages.some((message) => message.content === PLAN_GENERATING_MESSAGE), false);
  const retried = applyGenerationStarted(failed);
  assert.equal(retried.messages.at(-1)?.content, PLAN_GENERATING_MESSAGE);
  assert.equal(retried.messages.some((message) => message.content === PLAN_GENERATION_FAILED_MESSAGE), false);
});
