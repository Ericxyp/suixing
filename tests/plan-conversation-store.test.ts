import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAN_COMPLETE_MESSAGE,
  appendUserMessage,
  applyExtractionResult,
  createEmptyPlanConversation,
} from '../src/services/plan-conversation-service';
import {
  PLAN_CONVERSATION_STORAGE_KEY,
  createPlanConversationStore,
  deserializePlanConversation,
  serializePlanConversation,
} from '../src/services/plan-conversation-store';

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }

  removeItem(key: string) {
    this.data.delete(key);
  }
}

test('restores a safe conversation session and clears it after generate', () => {
  const storage = new MemoryStorage();
  const store = createPlanConversationStore(storage);
  const session = applyExtractionResult(
    appendUserMessage(createEmptyPlanConversation(), '去上海玩 3 天，2 人，预算 5000'),
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

  store.save(session);
  const restored = store.load();
  assert.equal(restored?.messages[0]?.content, '去上海玩 3 天，2 人，预算 5000');
  assert.equal(restored?.draft.destination, '上海');
  assert.equal(restored?.messages.at(-1)?.content, PLAN_COMPLETE_MESSAGE);
  assert.equal(storage.getItem(PLAN_CONVERSATION_STORAGE_KEY)?.includes('DASHSCOPE'), false);
  assert.equal(storage.getItem(PLAN_CONVERSATION_STORAGE_KEY)?.includes('choices'), false);

  store.clear();
  assert.equal(store.load(), null);
});

test('rejects unsafe stored payloads without using them as model output', () => {
  assert.equal(deserializePlanConversation('{"draft":{}}'), null);
  assert.equal(deserializePlanConversation('not-json'), null);
  const parsed = deserializePlanConversation(serializePlanConversation(
    appendUserMessage(createEmptyPlanConversation(), '去杭州'),
  ));
  assert.equal(parsed?.messages[0]?.role, 'user');
  assert.equal(parsed?.messages[0]?.content, '去杭州');
});
