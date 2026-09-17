import assert from 'node:assert/strict';
import test from 'node:test';
import { BffAiTripService } from '../src/services/bff-ai-trip-service';
import { mockAiTripService } from '../src/services/mock-ai-trip-service';
import {
  createRequirementExtractionService,
  getTripAiMode,
} from '../src/services/trip-requirement-service';
import { serializeDraft } from '../src/services/trip-requirement-draft-store';

test('parses trip AI mode and defaults unknown values to mock', () => {
  assert.equal(getTripAiMode('mock'), 'mock');
  assert.equal(getTripAiMode('bff'), 'bff');
  assert.equal(getTripAiMode(' bff '), 'bff');
  assert.equal(getTripAiMode(undefined), 'mock');
  assert.equal(getTripAiMode(''), 'mock');
  assert.equal(getTripAiMode('   '), 'mock');
  assert.equal(getTripAiMode('qwen'), 'mock');
  assert.equal(getTripAiMode('BFF'), 'mock');
});

test('factory selects Mock or BFF services without reading server env', async () => {
  const previous = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    QWEN_BASE_URL: process.env.QWEN_BASE_URL,
    QWEN_MODEL: process.env.QWEN_MODEL,
  };
  process.env.AI_PROVIDER = 'qwen';
  process.env.DASHSCOPE_API_KEY = 'should-not-be-read';
  process.env.QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  process.env.QWEN_MODEL = 'qwen3.7-plus';

  try {
    const mockService = createRequirementExtractionService(getTripAiMode(undefined));
    const explicitMock = createRequirementExtractionService(getTripAiMode('unknown'));
    const bffService = createRequirementExtractionService('bff', {
      fetch: async () =>
        new Response(JSON.stringify({
          data: {
            draft: { destination: '上海' },
            missingRequiredFields: [],
          },
        }), { headers: { 'content-type': 'application/json' } }),
    });

    assert.equal(mockService, mockAiTripService);
    assert.equal(explicitMock, mockAiTripService);
    assert.equal(createRequirementExtractionService('mock'), mockAiTripService);
    assert.equal(bffService instanceof BffAiTripService, true);
    assert.equal(createRequirementExtractionService(getTripAiMode('bff')) instanceof BffAiTripService, true);

    const mockResult = await mockService.extractRequirements('国庆去上海 3 天，两个人，预算 4000，喜欢咖啡');
    assert.equal(mockResult.draft.destination, '上海');
    assert.match(serializeDraft(mockResult), /"draft"/);
    assert.match(serializeDraft(mockResult), /"missingRequiredFields"/);
  } finally {
    restoreEnv('AI_PROVIDER', previous.AI_PROVIDER);
    restoreEnv('DASHSCOPE_API_KEY', previous.DASHSCOPE_API_KEY);
    restoreEnv('QWEN_BASE_URL', previous.QWEN_BASE_URL);
    restoreEnv('QWEN_MODEL', previous.QWEN_MODEL);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
