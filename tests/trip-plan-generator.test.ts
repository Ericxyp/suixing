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
  QwenTripPlanGenerator,
  TRIP_PLAN_CLASSIC_ROUTE_PROMPT,
  TRIP_PLAN_JSON_SCHEMA,
  TRIP_PLAN_MAX_OUTPUT_TOKENS,
  TRIP_PLAN_PREFERENCE_PRIORITY_PROMPT,
  TRIP_PLAN_RETRY_HINTS,
  TRIP_PLAN_SYSTEM_PROMPT,
  TRIP_PLAN_TEMPERATURE,
  TripPlanValidationError,
  hasExplicitTravelPreferences,
  parseConfirmedTripRequirement,
  parseTripPlanSuggestion,
  type ConfirmedTripRequirement,
  type TripPlanSuggestion,
  type TripPlanValidationReason,
} from '../server/services/trip-plan-generator';

const requirement: ConfirmedTripRequirement = {
  destination: '上海',
  origin: '北京',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  preferences: {
    interests: ['咖啡', '建筑'],
    avoid: ['夜店'],
  },
};

function place(name: string, category: TripPlanSuggestion['days'][number]['placeQueries'][number]['category'] = 'sight') {
  return {
    name,
    query: name,
    category,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步与建筑偏好。',
  };
}

function day(dayNumber: number): TripPlanSuggestion['days'][number] {
  return {
    dayNumber,
    title: `第${dayNumber}日街区漫步`,
    summary: '减少跨城移动，以步行和咖啡为主。',
    placeQueries: [place(`地点${dayNumber}甲`), place(`地点${dayNumber}乙`, 'coffee')],
  };
}

function validPlan(durationDays = 3): TripPlanSuggestion {
  return {
    title: '上海 3 天游',
    summary: '适合轻松漫步、咖啡与建筑探索的上海行程。',
    days: Array.from({ length: durationDays }, (_, index) => day(index + 1)),
  };
}

class FakeAiProvider implements AiProvider {
  calls: AiCompletionInput[] = [];

  constructor(
    private readonly handler: (
      input: AiCompletionInput,
    ) => Promise<{ content: string }> = async () => ({
      content: JSON.stringify(validPlan()),
    }),
  ) {}

  async complete(input: AiCompletionInput): Promise<{ content: string }> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }
}

test('parses a confirmed requirement and ignores unknown wrappers', () => {
  const parsed = parseConfirmedTripRequirement({
    ...requirement,
    destination: '  上海  ',
    preferences: {
      interests: ['咖啡', '咖啡', ' 建筑 '],
      avoid: ['', '夜店'],
    },
  });
  assert.equal(parsed?.destination, '上海');
  assert.deepEqual(parsed?.preferences?.interests, ['咖啡', '建筑']);
  assert.deepEqual(parsed?.preferences?.avoid, ['夜店']);
  assert.equal(parseConfirmedTripRequirement({ ...requirement, extra: true }), undefined);
  assert.equal(parseConfirmedTripRequirement({ ...requirement, destination: '' }), undefined);
  assert.equal(parseConfirmedTripRequirement({
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 5000,
  }), undefined);
});

test('generates a normalized plan and keeps prompt plus schema on the provider only', async () => {
  const provider = new FakeAiProvider();
  const generator = new QwenTripPlanGenerator(provider);
  const original = structuredClone(requirement);

  const plan = await generator.generate(requirement);

  assert.deepEqual(plan, validPlan());
  assert.deepEqual(requirement, original);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].temperature, TRIP_PLAN_TEMPERATURE);
  assert.equal(provider.calls[0].maxOutputTokens, TRIP_PLAN_MAX_OUTPUT_TOKENS);
  assert.equal(provider.calls[0].enableThinking, false);
  assert.deepEqual(provider.calls[0].jsonSchema, TRIP_PLAN_JSON_SCHEMA);
  assert.equal(provider.calls[0].messages[0]?.content?.startsWith(TRIP_PLAN_SYSTEM_PROMPT), true);
  assert.equal((provider.calls[0].messages[0]?.content ?? '').includes(TRIP_PLAN_PREFERENCE_PRIORITY_PROMPT), true);
  assert.equal((provider.calls[0].messages[0]?.content ?? '').includes(TRIP_PLAN_CLASSIC_ROUTE_PROMPT), false);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /<confirmed_requirement>/);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /上海/);
  assert.doesNotThrow(() => validateAiCompletionInput(provider.calls[0]));
});

test('prompt and schema both require two or three searchable places per day', () => {
  const schema = JSON.stringify(TRIP_PLAN_JSON_SCHEMA);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /每一天必须刚好提供 2 或 3 个核心地点/);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /不要生成 4 个或更多地点/);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /故宫博物院/);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /禁止把地标、店铺和解释拼成一个 query/);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /可被地图服务直接检索/);
  assert.match(TRIP_PLAN_SYSTEM_PROMPT, /北京、上海、西安、成都、杭州/);
  assert.match(schema, /"minItems":2/);
  assert.match(schema, /"maxItems":3/);
  assert.match(schema, /"additionalProperties":false/);
});

test('empty preference lists are treated as no explicit travel preferences', () => {
  assert.equal(hasExplicitTravelPreferences({}), false);
  assert.equal(hasExplicitTravelPreferences({ preferences: undefined }), false);
  assert.equal(hasExplicitTravelPreferences({ preferences: { interests: [], mustVisit: ['  '], avoid: [], accommodation: [] } }), false);
  assert.equal(hasExplicitTravelPreferences({ preferences: { interests: ['咖啡'] } }), true);
  assert.equal(hasExplicitTravelPreferences({ preferences: { mustVisit: ['故宫'] } }), true);
  assert.equal(hasExplicitTravelPreferences({ preferences: { avoid: ['夜店'] } }), true);
  assert.equal(hasExplicitTravelPreferences({ preferences: { accommodation: ['民宿'] } }), true);
});

test('no-preference plans use the classic city route prompt without writing preferences', async () => {
  const provider = new FakeAiProvider();
  const generator = new QwenTripPlanGenerator(provider);
  const bare: ConfirmedTripRequirement = {
    destination: '北京',
    durationDays: 3,
    travelerCount: 3,
    totalBudget: 3000,
    pace: 'balanced',
  };
  const original = structuredClone(bare);
  await generator.generate(bare);
  const system = provider.calls[0].messages[0]?.content ?? '';
  assert.equal(system.includes(TRIP_PLAN_CLASSIC_ROUTE_PROMPT), true);
  assert.equal(system.includes(TRIP_PLAN_PREFERENCE_PRIORITY_PROMPT), false);
  assert.match(system, /城市经典主线路/);
  assert.match(system, /每天 2–3 个地点/);
  assert.match(system, /优先每天安排 3 个地理靠近/);
  assert.match(system, /不要输出体验段 JSON/);
  assert.equal(JSON.stringify(bare), JSON.stringify(original));
  assert.equal('preferences' in bare, false);
  assert.equal((provider.calls[0].messages[1]?.content ?? '').includes('"interests"'), false);
});

test('rejects inverted dates and out-of-range planning inputs before the provider', async () => {
  const provider = new FakeAiProvider();
  const generator = new QwenTripPlanGenerator(provider);
  const cases: unknown[] = [
    { ...requirement, startDate: '2026-10-05', endDate: '2026-10-01' },
    { ...requirement, durationDays: 15 },
    { ...requirement, travelerCount: 0 },
    { ...requirement, totalBudget: 50 },
    { ...requirement, destination: '上'.repeat(81) },
    { ...requirement, pace: 'slow' },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => generator.generate(input as ConfirmedTripRequirement),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.code, 'AI_INVALID_REQUEST');
        assert.equal(error.message, AI_INVALID_REQUEST_MESSAGE);
        return true;
      },
    );
  }
  assert.equal(provider.calls.length, 0);
});

test('rejects invalid model plans without leaking the raw content', () => {
  const invalid = (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.code, 'AI_INVALID_RESPONSE');
    assert.equal(error.message, AI_INVALID_RESPONSE_MESSAGE);
    return true;
  };
  const rawUnknown = JSON.stringify({ ...validPlan(), secret: true });
  const rawDays = JSON.stringify({
    ...validPlan(),
    days: [day(1), day(3), day(2)],
  });
  const rawEmpty = JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路')] }],
  });
  const rawTime = JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路'), { ...place('咖啡店', 'coffee'), suggestedStartTime: '25:00' }] }],
  });
  const rawDuration = JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路'), { ...place('咖啡店', 'coffee'), suggestedDurationMinutes: 10 }] }],
  });

  assert.throws(() => parseTripPlanSuggestion('not-json', 3), invalid);
  assert.throws(() => parseTripPlanSuggestion(rawUnknown, 3), invalid);
  assert.throws(() => parseTripPlanSuggestion(JSON.stringify({ ...validPlan(), days: [day(1), day(2)] }), 3), invalid);
  assert.throws(() => parseTripPlanSuggestion(rawDays, 3), invalid);
  assert.throws(() => parseTripPlanSuggestion(rawEmpty, 1), invalid);
  assert.throws(
    () =>
      parseTripPlanSuggestion(
        JSON.stringify({
          ...validPlan(1),
          days: [
            {
              ...day(1),
              placeQueries: [place('武康路'), place('田子坊'), place('外滩'), place('豫园')],
            },
          ],
        }),
        1,
      ),
    invalid,
  );
  assert.doesNotThrow(() =>
    parseTripPlanSuggestion(
      JSON.stringify({
        ...validPlan(1),
        days: [{ ...day(1), placeQueries: [place('武康路'), place('田子坊'), place('外滩')] }],
      }),
      1,
    ),
  );
  assert.throws(() => parseTripPlanSuggestion(rawTime, 1), invalid);
  assert.throws(() => parseTripPlanSuggestion(rawDuration, 1), invalid);
  assert.throws(() => parseTripPlanSuggestion(JSON.stringify({ ...validPlan(), days: [] }), 3), invalid);
});

function assertValidationReason(
  content: string,
  durationDays: number,
  reason: TripPlanValidationReason,
  forbidden: string[] = [],
) {
  try {
    parseTripPlanSuggestion(content, durationDays);
    assert.fail(`expected ${reason}`);
  } catch (error: unknown) {
    assert.ok(error instanceof TripPlanValidationError);
    assert.equal(error.validationReason, reason);
    assert.equal(error.code, 'AI_INVALID_RESPONSE');
    assert.equal(error.message, AI_INVALID_RESPONSE_MESSAGE);
    const serialized = `${error.message}${error.name}${error.validationReason}${JSON.stringify(error)}`;
    assert.equal(serialized.includes('sk-'), false);
    assert.equal(serialized.includes('dashscope'), false);
    assert.equal(serialized.includes('http'), false);
    assert.equal(serialized.includes('prompt'), false);
    for (const item of forbidden) {
      assert.equal(serialized.includes(item), false);
    }
  }
}

test('classifies invalid model JSON into safe validation reasons', () => {
  assertValidationReason('not-json', 3, 'NOT_JSON');
  assertValidationReason('[]', 3, 'ROOT_SHAPE_INVALID');
  assertValidationReason(JSON.stringify({ ...validPlan(), secret: true }), 3, 'UNKNOWN_FIELD', ['secret']);
  assertValidationReason(JSON.stringify({ ...validPlan(), days: [day(1), day(2)] }), 3, 'DAY_COUNT_MISMATCH');
  assertValidationReason(JSON.stringify({
    ...validPlan(),
    days: [day(1), day(3), day(2)],
  }), 3, 'DAY_NUMBER_INVALID');
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [day(1), { ...day(1) }],
  }), 1, 'DAY_COUNT_MISMATCH');
  assertValidationReason(JSON.stringify({
    ...validPlan(2),
    days: [day(1), { ...day(2), dayNumber: 1 }],
  }), 2, 'DUPLICATE_DAY_NUMBER');
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路')] }],
  }), 1, 'STOP_COUNT_OUT_OF_RANGE', ['武康路']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{
      ...day(1),
      placeQueries: [place('武康路'), place('田子坊'), place('外滩'), place('豫园')],
    }],
  }), 1, 'STOP_COUNT_OUT_OF_RANGE', ['武康路', '田子坊']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [{ ...place('武康路'), name: '   ' }, place('安福路')] }],
  }), 1, 'EMPTY_NAME', ['武康路', '安福路']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [{ ...place('武康路'), query: '' }, place('安福路')] }],
  }), 1, 'EMPTY_QUERY', ['武康路']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [{ ...place('武康路'), category: 'museum' as never }, place('安福路')] }],
  }), 1, 'INVALID_CATEGORY', ['museum', '武康路']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路'), { ...place('咖啡店', 'coffee'), suggestedStartTime: '25:00' }] }],
  }), 1, 'INVALID_TIME', ['25:00', '咖啡店']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), placeQueries: [place('武康路'), { ...place('咖啡店', 'coffee'), suggestedDurationMinutes: 10 }] }],
  }), 1, 'INVALID_DURATION', ['咖啡店']);
  assertValidationReason(JSON.stringify({
    ...validPlan(2),
    days: [
      day(1),
      { ...day(2), placeQueries: [place('地点1甲'), place('新地点')] },
    ],
  }), 2, 'DUPLICATE_PLACE_QUERY', ['地点1甲', '新地点']);
  assertValidationReason(JSON.stringify({
    ...validPlan(1),
    days: [{ ...day(1), title: '标'.repeat(81) }],
  }), 1, 'TEXT_TOO_LONG');
});

test('preserves provider errors without wrapping', async () => {
  const original = new AiProviderError('AI_PROVIDER_ERROR', '智能服务暂时不可用，请稍后重试。');
  const provider = new FakeAiProvider(async () => {
    throw original;
  });
  const generator = new QwenTripPlanGenerator(provider);
  await assert.rejects(
    () => generator.generate(requirement),
    (error: unknown) => {
      assert.equal(error, original);
      return true;
    },
  );
  assert.equal(provider.calls.length, 1);
});

test('retries once after INVALID_TIME then accepts a valid plan', async () => {
  let attempts = 0;
  const invalidTime = JSON.stringify({
    ...validPlan(),
    days: validPlan().days.map((item, index) => (
      index === 0
        ? {
          ...item,
          placeQueries: [
            { ...item.placeQueries[0], suggestedStartTime: '25:00' },
            item.placeQueries[1],
          ],
        }
        : item
    )),
  });
  const provider = new FakeAiProvider(async () => {
    attempts += 1;
    if (attempts === 1) {
      return { content: invalidTime };
    }
    return { content: JSON.stringify(validPlan()) };
  });
  const generator = new QwenTripPlanGenerator(provider);
  const plan = await generator.generate(requirement);
  assert.equal(plan.days.length, 3);
  assert.equal(provider.calls.length, 2);
  assert.equal(generator.lastPlanDiagnostics?.retried, true);
  assert.equal(generator.lastPlanDiagnostics?.validationReason, 'INVALID_TIME');
  assert.match(provider.calls[1].messages[1]?.content ?? '', /必须严格遵守 JSON Schema/);
  assert.equal((provider.calls[1].messages[1]?.content ?? '').includes(TRIP_PLAN_RETRY_HINTS.INVALID_TIME), true);
  assert.equal((provider.calls[1].messages[1]?.content ?? '').includes('25:00'), false);
  assert.equal(provider.calls[1].maxOutputTokens, TRIP_PLAN_MAX_OUTPUT_TOKENS);
  assert.equal(provider.calls[1].enableThinking, false);
});

test('retries once after STOP_COUNT_OUT_OF_RANGE then accepts a valid plan', async () => {
  let attempts = 0;
  const tooMany = JSON.stringify({
    ...validPlan(1),
    days: [{
      ...day(1),
      placeQueries: [place('甲'), place('乙'), place('丙'), place('丁')],
    }],
  });
  const oneDayRequirement = { ...requirement, durationDays: 1, endDate: '2026-10-01' };
  const provider = new FakeAiProvider(async () => {
    attempts += 1;
    if (attempts === 1) {
      return { content: tooMany };
    }
    return { content: JSON.stringify(validPlan(1)) };
  });
  const generator = new QwenTripPlanGenerator(provider);
  const plan = await generator.generate(oneDayRequirement);
  assert.equal(plan.days[0].placeQueries.length, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal((provider.calls[1].messages[1]?.content ?? '').includes(TRIP_PLAN_RETRY_HINTS.STOP_COUNT_OUT_OF_RANGE), true);
});

test('retries once when the model plan is invalid then accepts a valid plan', async () => {
  let attempts = 0;
  const provider = new FakeAiProvider(async () => {
    attempts += 1;
    if (attempts === 1) {
      return { content: 'not-json' };
    }
    return { content: JSON.stringify(validPlan()) };
  });
  const generator = new QwenTripPlanGenerator(provider);
  const plan = await generator.generate(requirement);
  assert.equal(plan.days.length, 3);
  assert.equal(provider.calls.length, 2);
});

test('does not retry a second invalid plan indefinitely', async () => {
  const provider = new FakeAiProvider(async () => ({ content: 'not-json' }));
  const generator = new QwenTripPlanGenerator(provider);
  await assert.rejects(
    () => generator.generate(requirement),
    (error: unknown) => (
      error instanceof TripPlanValidationError
      && error.validationReason === 'NOT_JSON'
    ),
  );
  assert.equal(provider.calls.length, 2);
});
