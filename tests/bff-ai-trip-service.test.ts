import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BffAiTripService,
  parseRequirementExtractionPayload,
} from '../src/services/bff-ai-trip-service';
import {
  BffClientError,
  type FetchLike,
} from '../src/services/bff-client';

const NETWORK_ERROR_MESSAGE = '网络异常，请稍后重试。';
const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const SECRET_KEY = 'sk-test-dashscope-key';
const MODEL_NAME = 'qwen3.7-plus';
const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const VALID_INPUT = '10月1日从北京出发，两个人去上海玩3天，预算5000元，想轻松一点，喜欢咖啡和建筑。';

const validResult = {
  draft: {
    destination: '上海',
    origin: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 5000,
    pace: 'relaxed' as const,
    preferences: { interests: ['咖啡', '建筑'] },
  },
  missingRequiredFields: [] as Array<{ field: string; message: string }>,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function assertSafeError(error: unknown, code: BffClientError['code'], message: string): boolean {
  assert.ok(error instanceof BffClientError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  const serialized = `${error.message}${String(error)}${JSON.stringify(error)}`;
  assert.equal(serialized.includes(SECRET_KEY), false);
  assert.equal(serialized.includes(MODEL_NAME), false);
  assert.equal(serialized.includes(BASE_URL), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes(VALID_INPUT), false);
  assert.equal(serialized.includes('/api/ai/requirements/extract'), false);
  assert.equal(serialized.includes('stack'), false);
  return true;
}

test('posts only the local extract endpoint and clones the result', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const payload = { data: structuredClone(validResult) };
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse(payload);
  };
  const service = new BffAiTripService(fakeFetch);
  const original = structuredClone(payload);

  const result = await service.extractRequirements(VALID_INPUT);
  result.draft.destination = '杭州';
  result.draft.preferences!.interests.push('博物馆');
  payload.data.draft.totalBudget = 1;

  assert.equal(result.draft.destination, '杭州');
  assert.equal(result.draft.totalBudget, 5000);
  assert.deepEqual(result.draft.preferences?.interests, ['咖啡', '建筑', '博物馆']);
  assert.equal(original.data.draft.destination, '上海');
  assert.equal(original.data.draft.totalBudget, 5000);
  assert.deepEqual(original.data.draft.preferences.interests, ['咖啡', '建筑']);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, '/api/ai/requirements/extract');
  assert.equal(captured[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured[0].init?.body)), { input: VALID_INPUT });
  assert.equal(String(captured[0].init?.body).includes(SECRET_KEY), false);
  assert.equal(String(captured[0].init?.body).includes(MODEL_NAME), false);
});

test('rejects blank and oversized input before fetch', async () => {
  const captured: string[] = [];
  const service = new BffAiTripService(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: validResult });
  });

  await assert.rejects(
    () => service.extractRequirements('   '),
    (error: unknown) =>
      assertSafeError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  await assert.rejects(
    () => service.extractRequirements('去'.repeat(2001)),
    (error: unknown) =>
      assertSafeError(error, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE),
  );
  assert.deepEqual(captured, []);
});

test('maps 400, 503, and 502 BFF errors without leaking secrets', async () => {
  const cases: Array<{ status: number; body: unknown; code: BffClientError['code']; message: string }> = [
    {
      status: 400,
      body: { error: { code: 'INVALID_REQUEST', message: '旅行需求无效，请调整后重试。' } },
      code: 'INVALID_REQUEST',
      message: '旅行需求无效，请调整后重试。',
    },
    {
      status: 503,
      body: { error: { code: 'AI_PROVIDER_UNAVAILABLE', message: '智能服务尚未配置。' } },
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: '智能服务尚未配置。',
    },
    {
      status: 502,
      body: {
        error: {
          code: 'AI_PROVIDER_ERROR',
          message: `RAW ${SECRET_KEY} ${MODEL_NAME} ${BASE_URL}`,
        },
      },
      code: 'AI_PROVIDER_ERROR',
      message: '服务暂时不可用，请稍后重试。',
    },
  ];

  for (const item of cases) {
    const service = new BffAiTripService(async () => jsonResponse(item.body, item.status));
    await assert.rejects(
      () => service.extractRequirements(VALID_INPUT),
      (error: unknown) => assertSafeError(error, item.code, item.message),
    );
  }
});

test('converts network, timeout, non-JSON, and invalid payloads into stable errors', async () => {
  await assert.rejects(
    () =>
      new BffAiTripService(async () => {
        throw new Error(`ECONNRESET ${SECRET_KEY} at ${BASE_URL}`);
      }).extractRequirements(VALID_INPUT),
    (error: unknown) => assertSafeError(error, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE),
  );

  let receivedSignal: AbortSignal | undefined;
  const hangingFetch: FetchLike = (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException(`Aborted ${BASE_URL}`, 'AbortError')),
        { once: true },
      );
    });
  };
  await assert.rejects(
    () => new BffAiTripService(hangingFetch, 5).extractRequirements(VALID_INPUT),
    (error: unknown) => assertSafeError(error, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE),
  );
  assert.equal(receivedSignal?.aborted, true);

  await assert.rejects(
    () =>
      new BffAiTripService(async () =>
        new Response(`<html>${SECRET_KEY}</html>`, { status: 200, headers: { 'content-type': 'text/html' } }),
      ).extractRequirements(VALID_INPUT),
    (error: unknown) => assertSafeError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE),
  );

  await assert.rejects(
    () =>
      new BffAiTripService(async () =>
        jsonResponse({ data: { draft: { destination: '上海', model: MODEL_NAME }, missingRequiredFields: [] } }),
      ).extractRequirements(VALID_INPUT),
    (error: unknown) => assertSafeError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE),
  );
});

test('does not treat extra result fields or unknown issue shapes as valid', () => {
  assert.throws(
    () =>
      parseRequirementExtractionPayload({
        data: {
          draft: { destination: '上海' },
          missingRequiredFields: [],
          prompt: VALID_INPUT,
        },
      }),
    (error: unknown) => assertSafeError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE),
  );
  assert.throws(
    () =>
      parseRequirementExtractionPayload({
        data: {
          draft: { destination: '上海' },
          missingRequiredFields: [{ field: 'budget', message: '补预算' }],
        },
      }),
    (error: unknown) => assertSafeError(error, 'INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE),
  );
});
