import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiCompletionInput, AiProvider } from '../server/services/ai-provider';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AiProviderError,
  validateAiCompletionInput,
} from '../server/services/ai-provider';
import {
  QwenTripChangeIntentExtractor,
  TRIP_CHANGE_INTENT_JSON_SCHEMA,
  TRIP_CHANGE_INTENT_MAX_OUTPUT_TOKENS,
  TRIP_CHANGE_INTENT_RETRY_PROMPT,
  TRIP_CHANGE_INTENT_SYSTEM_PROMPT,
  TRIP_CHANGE_INTENT_TEMPERATURE,
  TripChangeIntentValidationError,
  parseTripChangeIntent,
  parseTripChangeInterpretBody,
  retryHintForTripChangeIntent,
  type TripChangeContext,
} from '../server/services/trip-change-intent-extractor';
import type { GenerationStageLog } from '../server/services/generation-logger';

const context: TripChangeContext = {
  tripId: 'trip-001',
  destination: '北京',
  days: [
    {
      dayNumber: 1,
      stops: [{
        tripPlaceId: 'trip-001:day:1:stop:1',
        placeName: '故宫博物院',
        type: 'attraction',
        startTime: '10:00',
      }],
    },
    {
      dayNumber: 2,
      stops: [{
        tripPlaceId: 'trip-001:day:2:stop:1',
        placeName: '慕田峪长城',
        type: 'attraction',
        startTime: '10:00',
      }],
    },
    {
      dayNumber: 3,
      stops: [{
        tripPlaceId: 'trip-001:day:3:stop:1',
        placeName: '颐和园',
        type: 'attraction',
        startTime: '10:00',
      }],
    },
  ],
};

function operationFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'REPLACE_PLACE',
    dayNumber: 2,
    targetTripPlaceId: 'trip-001:day:2:stop:1',
    replacementQuery: '圆明园',
    ...overrides,
  };
}

function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ready',
    summary: '将第二天的慕田峪长城换成圆明园。',
    operations: [operationFields()],
    ...overrides,
  });
}

class FakeAiProvider implements AiProvider {
  calls: AiCompletionInput[] = [];

  constructor(
    private readonly handler: (
      input: AiCompletionInput,
    ) => Promise<{ content: string }> = async () => ({ content: intentJson() }),
  ) {}

  async complete(input: AiCompletionInput): Promise<{ content: string }> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }
}

function assertNoLeak(text: string): void {
  for (const secret of [
    'dashscope.aliyuncs.com',
    'qwen3.7-plus',
    'Authorization',
    'trip_change_intent',
    '<change_request>',
    'RAW_UPSTREAM',
    'key=secret',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('interprets replacing Mutianyu on day 2 with Yuanmingyuan', async () => {
  const provider = new FakeAiProvider();
  const extractor = new QwenTripChangeIntentExtractor(provider);
  const original = structuredClone(context);
  const intent = await extractor.interpret('第二天不要去慕田峪长城，换成圆明园。', context);
  assert.deepEqual(intent, {
    status: 'ready',
    summary: '将第二天的慕田峪长城换成圆明园。',
    operations: [{
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'trip-001:day:2:stop:1',
      replacementQuery: '圆明园',
    }],
  });
  assert.deepEqual(context, original);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].temperature, TRIP_CHANGE_INTENT_TEMPERATURE);
  assert.equal(provider.calls[0].maxOutputTokens, TRIP_CHANGE_INTENT_MAX_OUTPUT_TOKENS);
  assert.equal(provider.calls[0].enableThinking, false);
  assert.deepEqual(provider.calls[0].jsonSchema, TRIP_CHANGE_INTENT_JSON_SCHEMA);
  assert.equal(provider.calls[0].messages[0]?.content, TRIP_CHANGE_INTENT_SYSTEM_PROMPT);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /<change_request>/);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /<trip_context>/);
  assert.doesNotThrow(() => validateAiCompletionInput(provider.calls[0]));
});

test('unsupported add or remove operations are invalid model output', () => {
  assert.throws(
    () => parseTripChangeIntent(JSON.stringify({
      status: 'ready',
      summary: '删除第二天的长城。',
      operations: [operationFields({
        type: 'REMOVE_PLACE',
        replacementQuery: '圆明园',
      })],
    }), context),
    (error: unknown) => error instanceof TripChangeIntentValidationError
      && error.validationReason === 'UNSUPPORTED_OPERATION',
  );
  assert.throws(
    () => parseTripChangeIntent(JSON.stringify({
      status: 'ready',
      summary: '在第一天增加一个咖啡馆。',
      operations: [operationFields({
        type: 'ADD_PLACE',
        dayNumber: 1,
        targetTripPlaceId: 'trip-001:day:1:stop:1',
        replacementQuery: '咖啡馆',
      })],
    }), context),
    (error: unknown) => error instanceof TripChangeIntentValidationError
      && error.validationReason === 'UNSUPPORTED_OPERATION',
  );
});

test('asks for clarification instead of guessing a looser day', async () => {
  const provider = new FakeAiProvider(async () => ({
    content: JSON.stringify({
      status: 'needs_clarification',
      summary: '你想调整第二天的哪一个地点？',
      operations: [],
    }),
  }));
  const intent = await new QwenTripChangeIntentExtractor(provider).interpret('第二天轻松一点', context);
  assert.deepEqual(intent, {
    status: 'needs_clarification',
    summary: '你想调整第二天的哪一个地点？',
    operations: [],
  });
});

test('rejects missing, cross-day, invented, duplicate and excess operations', () => {
  const cases: Array<{ content: string; reason: string }> = [
    {
      reason: 'UNKNOWN_TARGET',
      content: JSON.stringify({
        status: 'ready',
        summary: '替换一个不存在的地点。',
        operations: [operationFields({ targetTripPlaceId: 'trip-001:day:2:stop:9' })],
      }),
    },
    {
      reason: 'TARGET_DAY_MISMATCH',
      content: JSON.stringify({
        status: 'ready',
        summary: '把第一天的编号用到第二天。',
        operations: [operationFields({
          dayNumber: 2,
          targetTripPlaceId: 'trip-001:day:1:stop:1',
        })],
      }),
    },
    {
      reason: 'UNKNOWN_TARGET',
      content: JSON.stringify({
        status: 'ready',
        summary: '使用虚构编号。',
        operations: [operationFields({ targetTripPlaceId: 'invented-id' })],
      }),
    },
    {
      reason: 'TOO_MANY_OPERATIONS',
      content: JSON.stringify({
        status: 'ready',
        summary: '重复同一替换。',
        operations: [operationFields(), operationFields()],
      }),
    },
    {
      reason: 'TOO_MANY_OPERATIONS',
      content: JSON.stringify({
        status: 'ready',
        summary: '一次改太多。',
        operations: [
          operationFields(),
          operationFields({ replacementQuery: '北海公园' }),
          operationFields({ replacementQuery: '咖啡馆' }),
        ],
      }),
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => parseTripChangeIntent(item.content, context),
      (error: unknown) => {
        assert.ok(error instanceof TripChangeIntentValidationError);
        assert.equal(error.code, 'AI_INVALID_RESPONSE');
        assert.equal(error.message, AI_INVALID_RESPONSE_MESSAGE);
        assert.equal(error.validationReason, item.reason);
        assertNoLeak(String(error));
        return true;
      },
    );
  }
});

test('rejects illegal interpret bodies without treating them as model output', () => {
  const cases: unknown[] = [
    {},
    { input: '   ', context },
    { input: 12, context },
    { input: '改行程', context, model: 'qwen3.7-plus' },
    { input: '改行程', context, key: 'secret' },
    {
      input: '改行程',
      context: {
        ...context,
        routes: [],
      },
    },
    {
      input: '改行程',
      context: {
        ...context,
        days: [{
          dayNumber: 1,
          stops: [{
            ...context.days[0].stops[0],
            latitude: 39.9,
            longitude: 116.4,
          }],
        }],
      },
    },
    {
      input: '改行程',
      context: {
        ...context,
        days: [{
          dayNumber: 1,
          stops: [{
            ...context.days[0].stops[0],
            address: '北京市东城区',
          }],
        }],
      },
    },
    {
      input: '改行程',
      context: {
        ...context,
        totalBudget: 3000,
      },
    },
    {
      input: '第二天不要去长城了',
      trip: { id: 'trip-001', days: [] },
      context,
    },
  ];
  for (const body of cases) {
    assert.equal(parseTripChangeInterpretBody(body), undefined);
  }
});

test('enforces day, stop, length and clock limits on context', () => {
  assert.equal(parseTripChangeInterpretBody({
    input: '改',
    context: {
      ...context,
      days: Array.from({ length: 15 }, (_item, index) => ({
        dayNumber: index + 1,
        stops: [{
          tripPlaceId: `trip-001:day:${index + 1}:stop:1`,
          placeName: '示例',
          type: 'attraction',
          startTime: '10:00',
        }],
      })),
    },
  }), undefined);
  assert.equal(parseTripChangeInterpretBody({
    input: '改',
    context: {
      ...context,
      days: [{
        dayNumber: 1,
        stops: Array.from({ length: 7 }, (_item, index) => ({
          tripPlaceId: `trip-001:day:1:stop:${index + 1}`,
          placeName: '示例',
          type: 'attraction',
          startTime: '10:00',
        })),
      }],
    },
  }), undefined);
  assert.equal(parseTripChangeInterpretBody({
    input: '改'.repeat(1001),
    context,
  }), undefined);
  assert.equal(parseTripChangeInterpretBody({
    input: '改',
    context: {
      ...context,
      days: [{
        dayNumber: 1,
        stops: [{
          ...context.days[0].stops[0],
          startTime: '25:00',
        }],
      }],
    },
  }), undefined);
});

test('accepts replace operations that omit unused null fields', () => {
  const intent = parseTripChangeIntent(JSON.stringify({
    status: 'ready',
    summary: '将第二天的慕田峪长城换成圆明园。',
    operations: [{
      type: 'REPLACE_PLACE',
      dayNumber: 2,
      targetTripPlaceId: 'trip-001:day:2:stop:1',
      replacementQuery: '圆明园',
    }],
  }), context);
  assert.equal(intent.operations[0]?.type, 'REPLACE_PLACE');
});

test('retries once after UNKNOWN_TARGET then accepts a valid intent', async () => {
  let calls = 0;
  const logs: GenerationStageLog[] = [];
  const provider = new FakeAiProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: JSON.stringify({
          status: 'ready',
          summary: '替换一个不存在的地点。',
          operations: [operationFields({ targetTripPlaceId: 'invented-id' })],
        }),
      };
    }
    return { content: intentJson() };
  });
  const intent = await new QwenTripChangeIntentExtractor(provider, { logStage: (entry) => logs.push(entry) })
    .interpret('换成圆明园', context);
  assert.equal(intent.status, 'ready');
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls[1].messages[1]?.content ?? '', new RegExp(TRIP_CHANGE_INTENT_RETRY_PROMPT));
  assert.match(provider.calls[1].messages[1]?.content ?? '', /只能引用当前行程中已有的地点标识/);
  assert.equal((provider.calls[1].messages[1]?.content ?? '').includes('invented-id'), false);
  assert.equal(logs.some((entry) => entry.outcome === 'retried' && entry.validationReason === 'UNKNOWN_TARGET'), true);
});

test('does not retry provider failures', async () => {
  const provider = new FakeAiProvider(async () => {
    throw new AiProviderError('AI_PROVIDER_ERROR', 'dashscope.aliyuncs.com timeout');
  });
  await assert.rejects(
    () => new QwenTripChangeIntentExtractor(provider).interpret('换成圆明园', context),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'AI_PROVIDER_ERROR');
      assert.equal(String(error).includes('dashscope'), true);
      return true;
    },
  );
  assert.equal(provider.calls.length, 1);
});

test('two invalid JSON payloads return a stable 502 without leaking the model text', async () => {
  const logs: GenerationStageLog[] = [];
  const provider = new FakeAiProvider(async () => ({
    content: 'RAW_UPSTREAM not json {"secret":true}',
  }));
  await assert.rejects(
    () => new QwenTripChangeIntentExtractor(provider, { logStage: (entry) => logs.push(entry) })
      .interpret('换成圆明园', context),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'AI_INVALID_RESPONSE');
      assert.equal(error.message, AI_INVALID_RESPONSE_MESSAGE);
      assert.equal(error instanceof TripChangeIntentValidationError, false);
      assertNoLeak(JSON.stringify(error));
      assert.equal(String(error).includes('RAW_UPSTREAM'), false);
      return true;
    },
  );
  assert.equal(provider.calls.length, 2);
  assert.equal(logs.some((entry) => entry.outcome === 'retried' && entry.validationReason === 'NOT_JSON'), true);
  assert.equal(logs.some((entry) => entry.outcome === 'failed' && entry.validationReason === 'NOT_JSON'), true);
});

test('does not mutate model JSON or caller context', () => {
  const raw = intentJson();
  const frozenContext = structuredClone(context);
  parseTripChangeIntent(raw, context);
  assert.equal(raw.includes('圆明园'), true);
  assert.deepEqual(context, frozenContext);
});

test('blank interpret input is rejected before the provider', async () => {
  const provider = new FakeAiProvider();
  await assert.rejects(
    () => new QwenTripChangeIntentExtractor(provider).interpret('   ', context),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'AI_INVALID_REQUEST');
      assert.equal(error.message, AI_INVALID_REQUEST_MESSAGE);
      return true;
    },
  );
  assert.equal(provider.calls.length, 0);
});

test('exact same name on another day becomes needs_clarification without a second AI call', async () => {
  const provider = new FakeAiProvider(async () => ({
    content: JSON.stringify({
      status: 'ready',
      summary: '将第二天的慕田峪长城换成颐和园。',
      operations: [operationFields({ replacementQuery: '颐和园' })],
    }),
  }));
  const intent = await new QwenTripChangeIntentExtractor(provider).interpret(
    '第二天不要去慕田峪长城，换成颐和园。',
    context,
  );
  assert.deepEqual(intent, {
    status: 'needs_clarification',
    operations: [],
    summary: '颐和园已安排在 Day 3。你想换成其他地点，还是调整 Day 3 的行程？',
  });
  assert.equal(provider.calls.length, 1);
});

test('replacing a stop with its own name asks what the next place should be', async () => {
  const provider = new FakeAiProvider(async () => ({
    content: JSON.stringify({
      status: 'ready',
      summary: '将第二天的慕田峪长城换成慕田峪长城。',
      operations: [operationFields({ replacementQuery: '慕田峪长城' })],
    }),
  }));
  const intent = await new QwenTripChangeIntentExtractor(provider).interpret('第二天换成慕田峪长城', context);
  assert.equal(intent.status, 'needs_clarification');
  assert.deepEqual(intent.operations, []);
  assert.equal(intent.summary, '你希望将「慕田峪长城」替换成什么地点？');
});

test('partial name overlap is not treated as a cross-day conflict', async () => {
  const intent = parseTripChangeIntent(JSON.stringify({
    status: 'ready',
    summary: '将第二天的慕田峪长城换成圆明园遗址。',
    operations: [operationFields({ replacementQuery: '圆明园遗址' })],
  }), context);
  assert.equal(intent.status, 'ready');
  if (intent.operations[0]?.type !== 'REPLACE_PLACE') {
    throw new Error('expected replace');
  }
  assert.equal(intent.operations[0].replacementQuery, '圆明园遗址');
});

test('retry hints stay short and do not mention trip details', () => {
  assert.equal(retryHintForTripChangeIntent('UNKNOWN_TARGET'), '只能引用当前行程中已有的地点标识。');
  assert.equal(retryHintForTripChangeIntent('TARGET_DAY_MISMATCH'), '目标地点必须属于指定日期。');
  assert.equal(retryHintForTripChangeIntent('TOO_MANY_OPERATIONS'), '一次只处理一个地点替换。');
  assert.equal(retryHintForTripChangeIntent('EMPTY_QUERY'), '替换地点必须是简短、可检索的地点名称。');
});
