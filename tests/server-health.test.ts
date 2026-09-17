import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';

async function request(path: string, config: ServerConfig = { port: 3000, amapWebServiceKey: undefined, hasAmapWebServiceKey: false, hasAmapSecurityJsCode: false, hasQwenAiProvider: false }) {
  const server = createServer(createApp(config));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Temporary server failed to bind.');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('health endpoint returns only the public health payload', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await response.json(), { data: { status: 'ok', providers: { amapWebService: 'not-configured', amapJsSecurityProxy: 'not-configured', qwenAi: 'not-configured', tripGeneration: 'not-configured' } } });
});

test('unknown API endpoint returns stable JSON not found response', async () => {
  const response = await request('/api/unknown');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
});

test('health reports qwen as configured without leaking AI secrets', async () => {
  const config: ServerConfig = {
    port: 3000,
    hasAmapWebServiceKey: false,
    hasAmapSecurityJsCode: false,
    qwenApiKey: 'test-dashscope-api-key',
    qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    qwenModel: 'qwen3.7-plus',
    qwenRequestTimeoutMs: 60000,
    hasQwenAiProvider: true,
  };
  const response = await request('/api/health', config);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), {
    data: {
      status: 'ok',
      providers: {
        amapWebService: 'not-configured',
        amapJsSecurityProxy: 'not-configured',
        qwenAi: 'configured',
        tripGeneration: 'not-configured',
      },
    },
  });
  assert.equal(text.includes('test-dashscope-api-key'), false);
  assert.equal(text.includes('dashscope.aliyuncs.com'), false);
  assert.equal(text.includes('qwen3.7-plus'), false);
  assert.equal(text.includes('DASHSCOPE_API_KEY'), false);
  assert.equal(text.includes('qwenRequestTimeoutMs'), false);
  assert.equal(text.includes('60000'), false);
  assert.equal(text.includes('QWEN_REQUEST_TIMEOUT_MS'), false);
});

test('health reports tripGeneration configured only when the orchestrator is injected', async () => {
  const server = createServer(createApp(
    {
      port: 3000,
      hasAmapWebServiceKey: false,
      hasAmapSecurityJsCode: false,
      hasQwenAiProvider: false,
    },
    {
      tripGenerationOrchestrator: {
        async generate() {
          throw new Error('health must not generate');
        },
      },
    },
  ));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), {
      data: {
        status: 'ok',
        providers: {
          amapWebService: 'not-configured',
          amapJsSecurityProxy: 'not-configured',
          qwenAi: 'not-configured',
          tripGeneration: 'configured',
        },
      },
    });
    assert.equal(text.includes('DASHSCOPE'), false);
    assert.equal(text.includes('qwen3.7-plus'), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
