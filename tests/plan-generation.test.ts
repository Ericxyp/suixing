import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TripRequirementDraft } from '../src/domain/trip/ai';
import {
  applyExtractionResult,
  appendUserMessage,
  applySummaryDraftUpdate,
  createEmptyPlanConversation,
  formatSummaryEditIntent,
  getMissingRequirementFields,
  nextFollowUpQuestion,
  DESTINATION_QUESTION,
  PLAN_GENERATING_MESSAGE,
  PLAN_GENERATION_FAILED_MESSAGE,
} from '../src/services/plan-conversation-service';
import {
  PLAN_CREATE_ERROR_MESSAGE,
  PLAN_SAVE_ERROR_MESSAGE,
  clearPlanCreateLocks,
  creationFingerprint,
  createInitialPlanGenerationGate,
  decidePlanCreate,
  gateAfterDraftChange,
  restorePlanGenerationGate,
  runPlanTripCreate,
  shouldShowPlanCreateRetry,
} from '../src/services/plan-generation';
import {
  deserializePlanConversation,
  serializePlanConversation,
} from '../src/services/plan-conversation-store';

const completeDraft: TripRequirementDraft = {
  destination: '上海',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  preferences: { interests: ['咖啡', '建筑'] },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('incomplete drafts do not get a fingerprint and do not create a trip', async () => {
  clearPlanCreateLocks();
  const draft: TripRequirementDraft = { destination: '上海', travelerCount: 2 };
  assert.equal(creationFingerprint(draft), null);
  assert.ok(getMissingRequirementFields(draft).length > 0);
  assert.equal(nextFollowUpQuestion(getMissingRequirementFields(draft)), '计划什么时候出发、玩几天？');
  const result = await runPlanTripCreate({
    draft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      throw new Error('should not create');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid');
  }
});

test('a complete draft auto-creates once and does not emit a confirm CTA', async () => {
  clearPlanCreateLocks();
  let creates = 0;
  const first = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      creates += 1;
      return { id: 'trip-auto-001' };
    },
  });
  assert.equal(first.ok, true);
  const second = await runPlanTripCreate({
    draft: completeDraft,
    gate: first.ok ? first.gate : createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      creates += 1;
      return { id: 'trip-auto-002' };
    },
  });
  assert.equal(second.ok, false);
  assert.equal(creates, 1);
  const source = [
    readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/components/plan/PlanConversation.tsx'), 'utf8'),
    readFileSync(join(process.cwd(), 'src/components/plan/TravelSummary.tsx'), 'utf8'),
  ].join('\n');
  assert.equal(source.includes('生成旅行方案'), false);
  const page = readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8');
  assert.ok(page.indexOf('saveGeneratedTrip') < page.indexOf('planConversationStore.clear'));
  assert.ok(page.indexOf('planConversationStore.clear') < page.indexOf('navigate(`/trips/${result.tripId}`'));
  assert.equal(page.includes('saveTrip:'), false);
});

test('the same complete fingerprint cannot start a second in-flight create', async () => {
  clearPlanCreateLocks();
  let creates = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createTrip = async () => {
    creates += 1;
    await blocked;
    return { id: `trip-parallel-${creates}` };
  };
  const gate = createInitialPlanGenerationGate();
  const first = runPlanTripCreate({
    draft: completeDraft,
    gate,
    source: 'auto',
    userId: 'user-demo-001',
    createTrip,
  });
  await delay(5);
  const second = await runPlanTripCreate({
    draft: completeDraft,
    gate: { ...gate, fingerprint: creationFingerprint(completeDraft), status: 'generating' },
    source: 'auto',
    userId: 'user-demo-001',
    createTrip,
  });
  const retry = await runPlanTripCreate({
    draft: completeDraft,
    gate: { ...gate, fingerprint: creationFingerprint(completeDraft), status: 'failed', skipAutoStart: false },
    source: 'retry',
    userId: 'user-demo-001',
    createTrip,
  });
  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(second.ok, false);
  assert.equal(retry.ok, false);
  assert.equal(creates, 1);
});

test('changing budget or preferences produces a new fingerprint and allows another create', async () => {
  clearPlanCreateLocks();
  const created: string[] = [];
  const first = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      created.push('first');
      return { id: 'trip-1' };
    },
  });
  const updated = { ...completeDraft, totalBudget: 4000, preferences: { interests: ['建筑'] } };
  assert.notEqual(creationFingerprint(completeDraft), creationFingerprint(updated));
  const nextGate = gateAfterDraftChange(first.ok ? first.gate : createInitialPlanGenerationGate(), updated);
  assert.equal(nextGate.status, 'ready');
  assert.equal(nextGate.skipAutoStart, false);
  const second = await runPlanTripCreate({
    draft: updated,
    gate: nextGate,
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      created.push('second');
      return { id: 'trip-2' };
    },
  });
  assert.equal(second.ok, true);
  assert.deepEqual(created, ['first', 'second']);
});

test('an incomplete summary edit returns to a single follow-up and stops generation', () => {
  clearPlanCreateLocks();
  const started = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '上海 3 天 2 人 预算 5000'),
    { draft: completeDraft, missingRequiredFields: [] },
  );
  const incompleteDraft = { ...started.draft, destination: undefined };
  const incomplete = applySummaryDraftUpdate(
    started,
    incompleteDraft,
    formatSummaryEditIntent('destination', {}),
  );
  const gate = gateAfterDraftChange(
    { ...createInitialPlanGenerationGate(), status: 'ready', fingerprint: creationFingerprint(completeDraft) },
    incomplete.draft,
  );
  assert.equal(gate.status, 'collecting');
  assert.equal(creationFingerprint(incomplete.draft), null);
  assert.equal(nextFollowUpQuestion(incomplete.missingRequiredFields), DESTINATION_QUESTION);
  assert.equal(decidePlanCreate(gate, 'auto'), false);
});

test('a failed create keeps the session and allows a single retry', async () => {
  clearPlanCreateLocks();
  let attempts = 0;
  const failed = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      attempts += 1;
      throw new Error('upstream');
    },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.reason, 'failed');
    assert.equal(failed.gate.status, 'failed');
  }
  assert.equal(decidePlanCreate(failed.ok ? createInitialPlanGenerationGate() : failed.gate, 'auto'), false);
  assert.equal(shouldShowPlanCreateRetry(failed.ok ? createInitialPlanGenerationGate() : failed.gate), true);
  assert.equal(PLAN_CREATE_ERROR_MESSAGE, '暂时无法生成旅行方案，请稍后重试。');

  const retry = await runPlanTripCreate({
    draft: completeDraft,
    gate: failed.ok ? createInitialPlanGenerationGate() : failed.gate,
    source: 'retry',
    userId: 'user-demo-001',
    createTrip: async () => {
      attempts += 1;
      return { id: 'trip-retry' };
    },
  });
  assert.equal(retry.ok, true);
  assert.equal(attempts, 2);
});

test('generation failures skip repository save', async () => {
  clearPlanCreateLocks();
  let saves = 0;
  const failed = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      throw new Error('incomplete');
    },
    saveTrip: async () => {
      saves += 1;
    },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.reason, 'failed');
  }
  assert.equal(saves, 0);
});

test('repository save failures do not repeat generate until retry', async () => {
  clearPlanCreateLocks();
  let generates = 0;
  let saves = 0;
  const generated = { id: 'trip-unsaved' };
  const failed = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      generates += 1;
      return generated;
    },
    saveTrip: async () => {
      saves += 1;
      throw new Error('persist failed');
    },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.reason, 'save_failed');
    assert.equal(failed.gate.status, 'failed');
  }
  assert.equal(generates, 1);
  assert.equal(saves, 1);
  assert.equal(decidePlanCreate(failed.ok ? createInitialPlanGenerationGate() : failed.gate, 'auto'), false);
  assert.equal(PLAN_SAVE_ERROR_MESSAGE, '暂时无法保存旅行方案，请重试。');

  const retry = await runPlanTripCreate({
    draft: completeDraft,
    gate: failed.ok ? createInitialPlanGenerationGate() : failed.gate,
    source: 'retry',
    userId: 'user-demo-001',
    createTrip: async () => {
      generates += 1;
      return { id: 'trip-saved' };
    },
    saveTrip: async () => {
      saves += 1;
    },
  });
  assert.equal(retry.ok, true);
  assert.equal(generates, 2);
  assert.equal(saves, 2);
});

test('restoring a complete session does not auto-create', async () => {
  clearPlanCreateLocks();
  const restored = restorePlanGenerationGate(completeDraft);
  assert.equal(restored.skipAutoStart, true);
  assert.equal(restored.status, 'ready');
  assert.equal(decidePlanCreate(restored, 'auto'), false);
  assert.equal(shouldShowPlanCreateRetry(restored), true);
  const serialized = serializePlanConversation(applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '去上海玩 3 天，2 人，预算 5000'),
    { draft: completeDraft, missingRequiredFields: [] },
  ));
  assert.equal(serialized.includes('generating'), false);
  assert.equal(serialized.includes('failed'), false);
  assert.equal(serialized.includes(PLAN_GENERATING_MESSAGE), true);
  const parsed = deserializePlanConversation(serialized);
  assert.equal(parsed?.draft.destination, '上海');
  const afterRestore = await runPlanTripCreate({
    draft: completeDraft,
    gate: restorePlanGenerationGate(parsed?.draft ?? completeDraft),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      throw new Error('restored session must not create');
    },
  });
  assert.equal(afterRestore.ok, false);
});

test('complete extraction uses the generating copy instead of a confirm prompt', () => {
  const state = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '上海 3 天 2 人 预算 5000'),
    { draft: completeDraft, missingRequiredFields: [] },
  );
  assert.equal(state.messages.at(-1)?.content, PLAN_GENERATING_MESSAGE);
  const edited = applySummaryDraftUpdate(
    state,
    { ...state.draft, totalBudget: 4000 },
    formatSummaryEditIntent('totalBudget', { ...state.draft, totalBudget: 4000 }),
  );
  assert.match(edited.messages.at(-2)?.content ?? '', /将总预算调整为/);
  assert.equal(edited.messages.at(-1)?.content, PLAN_GENERATING_MESSAGE);
});

test('failed generation leaves failed status, failed copy and a retry without auto restart', async () => {
  clearPlanCreateLocks();
  const failed = await runPlanTripCreate({
    draft: completeDraft,
    gate: createInitialPlanGenerationGate(),
    source: 'auto',
    userId: 'user-demo-001',
    createTrip: async () => {
      throw new Error('incomplete');
    },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.gate.status, 'failed');
    assert.equal(decidePlanCreate(failed.gate, 'auto'), false);
    assert.equal(shouldShowPlanCreateRetry(failed.gate), true);
  }
  const conversation = readFileSync(join(process.cwd(), 'src/components/plan/PlanConversation.tsx'), 'utf8');
  const page = readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8');
  assert.match(page, /applyGenerationFailure/);
  assert.match(conversation, /PLAN_GENERATION_FAILED_MESSAGE/);
  assert.match(conversation, /generationStatus === 'failed'/);
  assert.equal(PLAN_GENERATION_FAILED_MESSAGE.includes('正在为你安排行程'), false);
  assert.equal(page.includes('调整目的地'), false);
});
