import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
  type AiCompletionInput,
} from '../server/services/ai-provider';
import {
  QwenAiProvider,
  type FetchLike,
} from '../server/services/qwen-ai-provider';
import { TRIP_REQUIREMENT_JSON_SCHEMA } from '../server/services/trip-requirement-extractor';

const TEST_KEY = 'test-dashscope-api-key';
const TEST_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const TEST_MODEL = 'qwen3.7-plus';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validInput(): AiCompletionInput {
  return {
    messages: [
      { role: 'system', content: '你是旅行规划助手。' },
      { role: 'user', content: '帮我规划上海三日游。' },
    ],
    temperature: 0.2,
    maxOutputTokens: 256,
  };
}

function assertAiError(
  error: unknown,
  code: AiProviderError['code'],
  message: string,
): boolean {
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  const serialized = `${error.message}${String(error)}${JSON.stringify(error)}`;
  assert.equal(serialized.includes(TEST_KEY), false);
  assert.equal(serialized.includes(TEST_BASE_URL), false);
  assert.equal(serialized.includes(TEST_MODEL), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('RAW_UPSTREAM'), false);
  return true;
}

function createProvider(fakeFetch: FetchLike, timeoutMs?: number): QwenAiProvider {
  return new QwenAiProvider(TEST_KEY, TEST_BASE_URL, TEST_MODEL, fakeFetch, timeoutMs);
}

function readTimeoutMs(provider: QwenAiProvider): number {
  return (provider as unknown as { timeoutMs: number }).timeoutMs;
}

test('posts chat completions with server-only model and Authorization header', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse({
      choices: [
        { message: { content: '' } },
        { message: { content: ' 上海三日行程草案。 ' } },
      ],
    });
  };
  const provider = createProvider(fakeFetch);
  const input = validInput();
  const original = structuredClone(input);

  const result = await provider.complete(input);

  assert.deepEqual(result, { content: ' 上海三日行程草案。 ' });
  assert.deepEqual(input, original);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${TEST_BASE_URL}/chat/completions`);
  assert.equal(captured[0].init?.method, 'POST');
  assert.equal(captured[0].init?.redirect, 'manual');
  const headers = new Headers(captured[0].init?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${TEST_KEY}`);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(String(captured[0].init?.body)), {
    model: TEST_MODEL,
    messages: original.messages,
    stream: false,
    temperature: 0.2,
    max_tokens: 256,
  });
  assert.equal('enable_thinking' in JSON.parse(String(captured[0].init?.body)), false);
  assert.equal(readTimeoutMs(provider), 60_000);
});

test('sends enable_thinking only when enableThinking is a boolean', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (_input, init) => {
    captured.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: 'ok' } }],
    });
  };
  const provider = createProvider(fakeFetch, 45_000);
  assert.equal(readTimeoutMs(provider), 45_000);

  await provider.complete({ ...validInput(), enableThinking: false });
  await provider.complete({ ...validInput(), enableThinking: true });
  await provider.complete(validInput());

  const disabled = JSON.parse(captured[0]) as Record<string, unknown>;
  const enabled = JSON.parse(captured[1]) as Record<string, unknown>;
  const omitted = JSON.parse(captured[2]) as Record<string, unknown>;
  assert.equal(disabled.enable_thinking, false);
  assert.equal(enabled.enable_thinking, true);
  assert.equal('enable_thinking' in omitted, false);
});

test('rejects non-boolean enableThinking before fetch', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  const input = {
    ...validInput(),
    enableThinking: 'false',
  } as unknown as AiCompletionInput;
  const original = structuredClone(input);

  await assert.rejects(
    () => provider.complete(input),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE),
  );
  assert.deepEqual(input, original);
  assert.deepEqual(captured, []);
});

test('adds response_format only when jsonSchema is provided', async () => {
  const captured: string[] = [];
  const schema = {
    name: 'trip_requirement_draft',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { destination: { type: ['string', 'null'] } },
    },
  };
  const provider = createProvider(async (_input, init) => {
    captured.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: '{"destination":null}' } }],
    });
  });

  await provider.complete({
    ...validInput(),
    jsonSchema: schema,
  });
  await provider.complete(validInput());

  const withSchema = JSON.parse(captured[0]) as Record<string, unknown>;
  const withoutSchema = JSON.parse(captured[1]) as Record<string, unknown>;
  assert.deepEqual(withSchema.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'trip_requirement_draft',
      strict: true,
      schema: schema.schema,
    },
  });
  assert.equal('response_format' in withoutSchema, false);
  assert.equal(JSON.stringify(withSchema).includes(TEST_KEY), false);
});

test('accepts the trip requirement JSON Schema without leaking model secrets', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (_input, init) => {
    captured.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
  });

  await provider.complete({
    messages: [{ role: 'user', content: '提取旅行需求' }],
    jsonSchema: TRIP_REQUIREMENT_JSON_SCHEMA,
  });

  const body = JSON.parse(captured[0]) as {
    response_format?: { json_schema?: { name?: string } };
  };
  assert.equal(body.response_format?.json_schema?.name, 'trip_requirement_draft');
  assert.equal(captured[0].includes(TEST_KEY), false);
  assert.equal(captured[0].includes(TEST_BASE_URL), false);
});

test('rejects unsafe jsonSchema before fetch', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  await assert.rejects(
    () =>
      provider.complete({
        ...validInput(),
        jsonSchema: {
          name: 'bad schema',
          schema: { type: 'object' },
        },
      }),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE),
  );
  await assert.rejects(
    () =>
      provider.complete({
        ...validInput(),
        jsonSchema: {
          name: 'tools',
          schema: { tools: [{ url: 'https://evil.example' }] },
        },
      }),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE),
  );
  assert.deepEqual(captured, []);
});

test('rejects invalid completion input before fetch', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });

  const cases: AiCompletionInput[] = [
    { messages: [] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: [{ role: 'tool' as 'user', content: '查询天气' }] },
    { messages: [{ role: 'user', content: 'a'.repeat(8_001) }] },
    { messages: [{ role: 'user', content: '上海' }], temperature: Number.NaN },
    { messages: [{ role: 'user', content: '上海' }], temperature: 2.1 },
    { messages: [{ role: 'user', content: '上海' }], maxOutputTokens: 0 },
    { messages: [{ role: 'user', content: '上海' }], maxOutputTokens: 1.5 },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => provider.complete(input),
      (error: unknown) =>
        assertAiError(error, 'AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE),
    );
  }

  assert.deepEqual(captured, []);
});

test('does not fetch when the API key is blank', async () => {
  const captured: string[] = [];
  const provider = new QwenAiProvider(
    '   ',
    TEST_BASE_URL,
    TEST_MODEL,
    async (input) => {
      captured.push(String(input));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
  );

  await assert.rejects(
    () => provider.complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_PROVIDER_UNAVAILABLE', AI_UNAVAILABLE_MESSAGE),
  );
  assert.deepEqual(captured, []);
});

test('converts timeout, network, non-2xx, and redirect failures without leaking secrets', async () => {
  let receivedSignal: AbortSignal | undefined;
  const hangingFetch: FetchLike = (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted at dashscope.aliyuncs.com', 'AbortError')),
        { once: true },
      );
    });
  };

  await assert.rejects(
    () => createProvider(hangingFetch, 5).complete(validInput()),
    (error: unknown) => {
      assertAiError(error, 'AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('dashscope.aliyuncs.com'), false);
      return true;
    },
  );
  assert.equal(receivedSignal?.aborted, true);

  await assert.rejects(
    () =>
      createProvider(async () => {
        throw new Error('ECONNRESET RAW_UPSTREAM at https://dashscope.aliyuncs.com');
      }).complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE),
  );

  await assert.rejects(
    () =>
      createProvider(async () =>
        new Response('RAW_UPSTREAM quota exceeded', { status: 429 }),
      ).complete(validInput()),
    (error: unknown) => {
      assertAiError(error, 'AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('RAW_UPSTREAM'), false);
      return true;
    },
  );

  await assert.rejects(
    () =>
      createProvider(async () =>
        new Response('redirect', {
          status: 302,
          headers: { location: 'https://evil.example/steal' },
        }),
      ).complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE),
  );
});

test('converts non-JSON, empty choices, and empty content into invalid responses', async () => {
  await assert.rejects(
    () =>
      createProvider(async () =>
        new Response('<html>RAW_UPSTREAM</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ).complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_RESPONSE', AI_INVALID_RESPONSE_MESSAGE),
  );

  await assert.rejects(
    () =>
      createProvider(async () => jsonResponse({ choices: [] })).complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_RESPONSE', AI_INVALID_RESPONSE_MESSAGE),
  );

  await assert.rejects(
    () =>
      createProvider(async () =>
        jsonResponse({ choices: [{ message: { content: '   ' } }] }),
      ).complete(validInput()),
    (error: unknown) =>
      assertAiError(error, 'AI_INVALID_RESPONSE', AI_INVALID_RESPONSE_MESSAGE),
  );
});
