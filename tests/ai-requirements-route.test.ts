import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
} from '../server/services/ai-provider';
import type { TripRequirementExtractor } from '../server/services/trip-requirement-extractor';
import type { RequirementExtractionResult } from '../src/domain/trip/ai';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const extraction: RequirementExtractionResult = {
  draft: {
    destination: '上海',
    origin: '北京',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 5000,
    pace: 'relaxed',
    preferences: { interests: ['咖啡'] },
  },
  missingRequiredFields: [],
};

const VALID_INPUT = '10月1日从北京出发，两个人去上海玩3天，预算5000元，轻松一点。';

class FakeExtractor implements TripRequirementExtractor {
  calls: string[] = [];

  constructor(
    private readonly handler: (input: string) => Promise<RequirementExtractionResult> = async () =>
      extraction,
  ) {}

  async extract(input: string): Promise<RequirementExtractionResult> {
    this.calls.push(input);
    return this.handler(input);
  }
}

async function request(
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    extractor?: TripRequirementExtractor;
  } = {},
): Promise<{ status: number; body: unknown; text: string; contentType: string }> {
  const server = createServer(
    createApp(config, { tripRequirementExtractor: options.extractor }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ai/requirements/extract`,
      {
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body,
      },
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return {
      status: response.status,
      body,
      text,
      contentType: response.headers.get('content-type') ?? '',
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

function assertNoSensitiveLeak(text: string): void {
  for (const secret of [
    'test-dashscope-api-key',
    'dashscope.aliyuncs.com',
    'qwen3.7-plus',
    'Authorization',
    'Bearer',
    'trip_requirement_draft',
    'json_schema',
    '<travel_request>',
    'RAW_UPSTREAM',
    'FAKE_STACK_SECRET',
    'Unexpected token',
    'SyntaxError',
    'stack',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('extracts travel requirements from a valid JSON body', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: jsonHeaders(),
    body: JSON.stringify({ input: VALID_INPUT }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: extraction });
  assert.deepEqual(extractor.calls, [VALID_INPUT]);
  assertNoSensitiveLeak(result.text);
  assert.equal('model' in (result.body as object), false);
  assert.equal('prompt' in (result.body as object), false);
});

test('returns 503 when the extractor is not injected', async () => {
  const result = await request({
    headers: jsonHeaders(),
    body: JSON.stringify({ input: VALID_INPUT }),
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: { code: 'AI_PROVIDER_UNAVAILABLE', message: AI_UNAVAILABLE_MESSAGE },
  });
  assertNoSensitiveLeak(result.text);
});

test('rejects invalid JSON bodies without calling the extractor', async () => {
  const extractor = new FakeExtractor();
  const cases = [
    JSON.stringify({}),
    JSON.stringify({ input: '   ' }),
    JSON.stringify({ input: 12 }),
    JSON.stringify(['去上海']),
    'null',
    JSON.stringify({ input: VALID_INPUT, model: 'qwen3.7-plus' }),
    JSON.stringify({ input: '去'.repeat(2001) }),
  ];

  for (const body of cases) {
    const result = await request({
      extractor,
      headers: jsonHeaders(),
      body,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '旅行需求无效，请调整后重试。' },
    });
    assert.match(result.contentType, /application\/json/);
    assertNoSensitiveLeak(result.text);
  }

  assert.equal(extractor.calls.length, 0);
});

test('rejects a non-JSON content type with 415', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ input: VALID_INPUT }),
  });

  assert.equal(result.status, 415);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '请使用 JSON 提交旅行需求。' },
  });
  assert.match(result.contentType, /application\/json/);
  assert.equal(extractor.calls.length, 0);
});

test('converts malformed JSON into a stable JSON 400', async () => {
  const extractor = new FakeExtractor();
  const result = await request({
    extractor,
    headers: jsonHeaders(),
    body: '{"input":',
  });

  assert.equal(result.status, 400);
  assert.match(result.contentType, /application\/json/);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '旅行需求无效，请调整后重试。' },
  });
  assert.equal(result.text.includes('<html'), false);
  assert.equal(extractor.calls.length, 0);
  assertNoSensitiveLeak(result.text);
});

test('rejects non-POST methods with JSON 405', async () => {
  const extractor = new FakeExtractor();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await request({ extractor, method });
    assert.equal(result.status, 405);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '仅支持提取旅行需求。' },
    });
    assert.match(result.contentType, /application\/json/);
  }
  assert.equal(extractor.calls.length, 0);
});

test('maps AiProviderError codes to stable HTTP responses', async () => {
  const cases: Array<{ error: AiProviderError; status: number }> = [
    {
      error: new AiProviderError('AI_INVALID_REQUEST', 'leaky user prompt'),
      status: 400,
    },
    {
      error: new AiProviderError('AI_PROVIDER_UNAVAILABLE', 'missing DASHSCOPE_API_KEY'),
      status: 503,
    },
    {
      error: new AiProviderError('AI_PROVIDER_ERROR', 'RAW_UPSTREAM 429'),
      status: 502,
    },
    {
      error: new AiProviderError('AI_INVALID_RESPONSE', '{"secret":true}'),
      status: 502,
    },
  ];
  const messages = {
    AI_INVALID_REQUEST: AI_INVALID_REQUEST_MESSAGE,
    AI_PROVIDER_UNAVAILABLE: AI_UNAVAILABLE_MESSAGE,
    AI_PROVIDER_ERROR: AI_PROVIDER_ERROR_MESSAGE,
    AI_INVALID_RESPONSE: AI_INVALID_RESPONSE_MESSAGE,
  } as const;

  for (const { error, status } of cases) {
    const extractor = new FakeExtractor(async () => {
      throw error;
    });
    const result = await request({
      extractor,
      headers: jsonHeaders(),
      body: JSON.stringify({ input: VALID_INPUT }),
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.body, {
      error: { code: error.code, message: messages[error.code] },
    });
    assertNoSensitiveLeak(result.text);
  }
});

test('converts unknown extractor failures into a stable JSON 500', async () => {
  const extractor = new FakeExtractor(async () => {
    throw new Error('FAKE_STACK_SECRET at dashscope.aliyuncs.com');
  });
  const result = await request({
    extractor,
    headers: jsonHeaders(),
    body: JSON.stringify({ input: VALID_INPUT }),
  });

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' },
  });
  assert.match(result.contentType, /application\/json/);
  assertNoSensitiveLeak(result.text);
});
