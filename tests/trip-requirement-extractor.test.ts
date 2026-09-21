import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiCompletionInput, AiProvider } from '../server/services/ai-provider';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AiProviderError,
} from '../server/services/ai-provider';
import {
  QwenTripRequirementExtractor,
  TRIP_REQUIREMENT_JSON_SCHEMA,
  TRIP_REQUIREMENT_SYSTEM_PROMPT,
  getMissingRequirementFields,
  parseRequirementDraft,
} from '../server/services/trip-requirement-extractor';

const COMPLETE_REQUEST = '10 月 1 日从北京出发，2 人去上海玩 3 天，预算 5000 元，轻松一点，想喝咖啡看建筑。';

const completeModelJson = {
  destination: '上海',
  origin: '北京',
  startDate: null,
  endDate: null,
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed',
  diningMode: null,
  preferences: {
    interests: ['咖啡', '建筑', '咖啡'],
    accommodation: [],
    mustVisit: [],
    avoid: [],
  },
  tripIntent: null,
  partyContext: null,
  constraints: null,
  profilePatch: null,
};

class FakeAiProvider implements AiProvider {
  calls: AiCompletionInput[] = [];

  constructor(
    private readonly handler: (
      input: AiCompletionInput,
    ) => Promise<{ content: string }> = async () => ({
      content: JSON.stringify(completeModelJson),
    }),
  ) {}

  async complete(input: AiCompletionInput): Promise<{ content: string }> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }
}

function emptyDraftJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    destination: null,
    origin: null,
    startDate: null,
    endDate: null,
    durationDays: null,
    travelerCount: null,
    totalBudget: null,
    pace: null,
    diningMode: null,
    preferences: {
      interests: [],
      accommodation: [],
      mustVisit: [],
      avoid: [],
    },
    tripIntent: null,
    partyContext: null,
    constraints: null,
    profilePatch: null,
    ...overrides,
  };
}

function assertNoRawModelContent(error: unknown, raw: string): void {
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.message.includes(raw), false);
  assert.equal(String(error).includes(raw), false);
}

test('extracts a complete Chinese travel request into a normalized draft', async () => {
  const provider = new FakeAiProvider();
  const extractor = new QwenTripRequirementExtractor(provider);

  const result = await extractor.extract(`  ${COMPLETE_REQUEST}  `);

  assert.deepEqual(result.draft, {
    destination: '上海',
    origin: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 5000,
    pace: 'relaxed',
    preferences: {
      interests: ['咖啡', '建筑'],
      accommodation: [],
      mustVisit: [],
      avoid: [],
    },
  });
  assert.deepEqual(result.missingRequiredFields, []);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].temperature, 0);
  assert.equal(provider.calls[0].maxOutputTokens, 700);
  assert.equal(provider.calls[0].enableThinking, false);
  assert.deepEqual(provider.calls[0].jsonSchema, TRIP_REQUIREMENT_JSON_SCHEMA);
  assert.equal(provider.calls[0].jsonSchema?.name, TRIP_REQUIREMENT_JSON_SCHEMA.name);
  assert.equal(provider.calls[0].messages[0]?.content, TRIP_REQUIREMENT_SYSTEM_PROMPT);
  assert.match(provider.calls[0].messages[0]?.content ?? '', /不得编造/);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /<travel_request>/);
  assert.match(provider.calls[0].messages[1]?.content ?? '', /<\/travel_request>/);
});

test('returns a partial draft and stable missing fields', async () => {
  const provider = new FakeAiProvider(async () => ({
    content: JSON.stringify(emptyDraftJson({ destination: '杭州' })),
  }));
  const extractor = new QwenTripRequirementExtractor(provider);
  const result = await extractor.extract('想去杭州。');

  assert.equal(result.draft.destination, '杭州');
  assert.equal(result.draft.pace, undefined);
  assert.deepEqual(result.missingRequiredFields, [
    { field: 'durationDays', message: '请补充日期或行程天数。' },
    { field: 'travelerCount', message: '请补充同行人数。' },
    { field: 'totalBudget', message: '请补充总预算。' },
  ]);
});

test('maps explicit restaurant arrangement and self-managed dining', () => {
  const arranged = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 3000,
    diningMode: 'arranged',
  })));
  assert.equal(arranged.diningMode, 'arranged');
  const selfManaged = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 3000,
    diningMode: 'self_managed',
  })));
  assert.equal(selfManaged.diningMode, 'self_managed');
  const unspecified = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 3000,
    diningMode: null,
  })));
  assert.equal(unspecified.diningMode, undefined);
});

test('does not invent a default pace when the model returns null', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '上海',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 1000,
    pace: null,
  })));
  assert.equal(draft.pace, undefined);
  assert.deepEqual(getMissingRequirementFields(draft), []);
});

test('normalizes dates, budget rounding, and valid date ranges', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '上海',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    travelerCount: 2,
    totalBudget: 4999.6,
  })));
  assert.equal(draft.startDate, '2026-10-01');
  assert.equal(draft.endDate, '2026-10-03');
  assert.equal(draft.totalBudget, 5000);
  assert.deepEqual(getMissingRequirementFields(draft), []);
});

test('clears inverted dates instead of inventing a correction', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    destination: '上海',
    startDate: '2026-10-05',
    endDate: '2026-10-01',
    travelerCount: 2,
    totalBudget: 1000,
  })));
  assert.equal(draft.startDate, undefined);
  assert.equal(draft.endDate, undefined);
  assert.deepEqual(getMissingRequirementFields(draft), [
    { field: 'durationDays', message: '请补充日期或行程天数。' },
  ]);
});

test('rejects blank or oversized user input without calling the provider', async () => {
  const provider = new FakeAiProvider();
  const extractor = new QwenTripRequirementExtractor(provider);

  await assert.rejects(
    () => extractor.extract('   '),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'AI_INVALID_REQUEST');
      assert.equal(error.message, AI_INVALID_REQUEST_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    () => extractor.extract('去'.repeat(2001)),
    (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, 'AI_INVALID_REQUEST');
      return true;
    },
  );
  assert.equal(provider.calls.length, 0);
});

test('preserves provider errors without wrapping', async () => {
  const original = new AiProviderError('AI_PROVIDER_UNAVAILABLE', '智能服务尚未配置。');
  const provider = new FakeAiProvider(async () => {
    throw original;
  });
  const extractor = new QwenTripRequirementExtractor(provider);

  await assert.rejects(
    () => extractor.extract('去上海。'),
    (error: unknown) => {
      assert.equal(error, original);
      return true;
    },
  );
});

test('rejects non-JSON, array roots, unknown fields, and illegal values', () => {
  const cases = [
    'not-json',
    '[]',
    JSON.stringify({ ...emptyDraftJson(), extra: true }),
    JSON.stringify(emptyDraftJson({ durationDays: '3' })),
    JSON.stringify(emptyDraftJson({ startDate: '2026-13-01' })),
    JSON.stringify(emptyDraftJson({ travelerCount: 0 })),
    JSON.stringify(emptyDraftJson({ totalBudget: -1 })),
    JSON.stringify(emptyDraftJson({ durationDays: 1.5 })),
  ];

  for (const raw of cases) {
    assert.throws(
      () => parseRequirementDraft(raw),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.code, 'AI_INVALID_RESPONSE');
        assert.equal(error.message, AI_INVALID_RESPONSE_MESSAGE);
        assertNoRawModelContent(error, raw);
        return true;
      },
    );
  }
});

test('does not mutate the model JSON string or caller input', async () => {
  const content = JSON.stringify(completeModelJson);
  const originalContent = content;
  const originalModel = structuredClone(completeModelJson);
  parseRequirementDraft(content);
  assert.equal(content, originalContent);
  assert.deepEqual(completeModelJson, originalModel);

  const provider = new FakeAiProvider(async () => ({ content }));
  const extractor = new QwenTripRequirementExtractor(provider);
  const input = ` ${COMPLETE_REQUEST} `;
  await extractor.extract(input);
  assert.equal(input, ` ${COMPLETE_REQUEST} `);
});

function profilePatchWith(signals: Record<string, { value: number; confidence: number; source: string }>) {
  return {
    signals: Object.entries(signals).map(([key, signal]) => ({ key, ...signal })),
  };
}

test('explicit long-term coffee and photography become a profile patch', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    profilePatch: profilePatchWith({
      coffee: { value: 0.9, confidence: 0.9, source: 'explicit' },
      photography: { value: 0.85, confidence: 0.8, source: 'explicit' },
    }),
  })));
  assert.equal(draft.tripIntent, undefined);
  assert.equal(draft.profilePatch?.signals.coffee?.source, 'explicit');
  assert.equal(draft.profilePatch?.signals.photography?.source, 'explicit');
});

test('this-trip history intent and shopping constraint do not become a profile patch', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    tripIntent: { interestKeys: ['history', 'culture_art'], pace: null },
    constraints: { excludedInterestKeys: ['shopping'], lowWalking: null },
    profilePatch: null,
  })));
  assert.deepEqual(draft.tripIntent?.interestKeys, ['history', 'culture_art']);
  assert.deepEqual(draft.constraints?.excludedInterestKeys, ['shopping']);
  assert.equal(draft.profilePatch, undefined);
});

test('parents and low walking become party context', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    partyContext: {
      partyType: 'parents',
      hasElderly: true,
      mobilityRequirement: 'low_walking',
    },
    constraints: { excludedInterestKeys: [], lowWalking: true },
  })));
  assert.equal(draft.partyContext?.partyType, 'parents');
  assert.equal(draft.partyContext?.hasElderly, true);
  assert.equal(draft.constraints?.lowWalking, true);
});

test('a single restaurant request does not create a behavioral profile patch', () => {
  const draft = parseRequirementDraft(JSON.stringify(emptyDraftJson({
    diningMode: 'arranged',
    preferences: {
      interests: ['餐厅'],
      accommodation: [],
      mustVisit: [],
      avoid: [],
    },
    profilePatch: null,
  })));
  assert.equal(draft.profilePatch, undefined);
  assert.equal(draft.diningMode, 'arranged');
});
