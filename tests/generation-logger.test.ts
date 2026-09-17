import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConsoleGenerationLogger,
  createGenerationRequestId,
  safeGenerationErrorCode,
  safeGenerationValidationReason,
  type GenerationStageLog,
} from '../server/services/generation-logger';

test('safe logger entries only include requestId, stage, duration, outcome and errorCode', () => {
  const captured: string[] = [];
  const original = console.info;
  console.info = (value?: unknown) => {
    captured.push(String(value));
  };
  try {
    const logger = createConsoleGenerationLogger();
    const entry: GenerationStageLog = {
      requestId: 'gabc123def456',
      stage: 'place_resolve',
      outcome: 'failed',
      durationMs: 42,
      errorCode: 'TRIP_GENERATION_INCOMPLETE',
    };
    logger.logStage(entry);
  } finally {
    console.info = original;
  }

  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['durationMs', 'errorCode', 'outcome', 'requestId', 'stage']);
  assert.equal(parsed.requestId, 'gabc123def456');
  assert.equal(parsed.stage, 'place_resolve');
  assert.equal(parsed.outcome, 'failed');
  assert.equal(parsed.durationMs, 42);
  assert.equal(parsed.errorCode, 'TRIP_GENERATION_INCOMPLETE');
  const serialized = captured[0];
  assert.equal(serialized.includes('destination'), false);
  assert.equal(serialized.includes('query'), false);
  assert.equal(serialized.includes('key'), false);
  assert.equal(serialized.includes('http'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('stack'), false);
  assert.equal(serialized.includes('dashscope'), false);
});

test('logger may include a safe validationReason and retried outcome', () => {
  const captured: string[] = [];
  const original = console.info;
  console.info = (value?: unknown) => {
    captured.push(String(value));
  };
  try {
    const logger = createConsoleGenerationLogger();
    logger.logStage({
      requestId: 'gabc123def456',
      stage: 'plan',
      outcome: 'retried',
      durationMs: 88,
      errorCode: 'AI_INVALID_RESPONSE',
      validationReason: 'INVALID_TIME',
      raw: '故宫博物院 dashscope.aliyuncs.com key=secret',
    } as GenerationStageLog & { raw: string });
  } finally {
    console.info = original;
  }
  const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['durationMs', 'errorCode', 'outcome', 'requestId', 'stage', 'validationReason'],
  );
  assert.equal(parsed.outcome, 'retried');
  assert.equal(parsed.validationReason, 'INVALID_TIME');
  assert.equal(captured[0].includes('故宫'), false);
  assert.equal(captured[0].includes('dashscope'), false);
  assert.equal(captured[0].includes('secret'), false);
  assert.equal(captured[0].includes('raw'), false);
});

test('change interpret logs omit requestId and never include trip details', () => {
  const captured: string[] = [];
  const original = console.info;
  console.info = (value?: unknown) => {
    captured.push(String(value));
  };
  try {
    const logger = createConsoleGenerationLogger();
    logger.logStage({
      requestId: 'gshouldomit01',
      stage: 'change_interpret',
      outcome: 'failed',
      durationMs: 12,
      errorCode: 'AI_INVALID_RESPONSE',
      validationReason: 'UNKNOWN_TARGET',
      raw: '第二天不要去慕田峪长城 trip-001 颐和园 prompt schema qwen3.7-plus key=secret https://dashscope.aliyuncs.com',
    } as GenerationStageLog & { raw: string });
  } finally {
    console.info = original;
  }
  const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['durationMs', 'errorCode', 'outcome', 'stage', 'validationReason'],
  );
  assert.equal(parsed.stage, 'change_interpret');
  assert.equal(parsed.validationReason, 'UNKNOWN_TARGET');
  assert.equal(captured[0].includes('gshouldomit01'), false);
  assert.equal(captured[0].includes('trip-001'), false);
  assert.equal(captured[0].includes('慕田峪'), false);
  assert.equal(captured[0].includes('颐和园'), false);
  assert.equal(captured[0].includes('prompt'), false);
  assert.equal(captured[0].includes('schema'), false);
  assert.equal(captured[0].includes('qwen'), false);
  assert.equal(captured[0].includes('key='), false);
  assert.equal(captured[0].includes('dashscope'), false);
  assert.equal(captured[0].includes('stack'), false);
  assert.equal(captured[0].includes('query'), false);
});

test('change apply logs omit requestId and never include trip details', () => {
  const captured: string[] = [];
  const original = console.info;
  console.info = (value?: unknown) => {
    captured.push(String(value));
  };
  try {
    const logger = createConsoleGenerationLogger();
    logger.logStage({
      requestId: 'gshouldomit02',
      stage: 'change_apply',
      outcome: 'success',
      durationMs: 40,
    });
  } finally {
    console.info = original;
  }
  const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['durationMs', 'outcome', 'stage']);
  assert.equal(parsed.stage, 'change_apply');
  assert.equal(captured[0].includes('gshouldomit02'), false);
  assert.equal(captured[0].includes('颐和园'), false);
});

test('safe error codes ignore messages, stacks and unknown shapes', () => {
  assert.equal(
    safeGenerationErrorCode({ code: 'AI_INVALID_RESPONSE', message: 'raw dump' }),
    'AI_INVALID_RESPONSE',
  );
  assert.equal(safeGenerationErrorCode({ code: 'not-safe', message: 'x' }), undefined);
  assert.equal(safeGenerationErrorCode(new Error('stack at restapi.amap.com')), undefined);
  assert.equal(safeGenerationValidationReason({ validationReason: 'INVALID_TIME' }), 'INVALID_TIME');
  assert.equal(safeGenerationValidationReason({ validationReason: '故宫博物院' }), undefined);
  assert.match(createGenerationRequestId(), /^g[a-f0-9]{12}$/);
});
