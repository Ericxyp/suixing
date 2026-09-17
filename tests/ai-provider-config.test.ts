import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerConfig } from '../server/config';
import { createAiProvider } from '../server/services/create-ai-provider';
import { QwenAiProvider } from '../server/services/qwen-ai-provider';

const VALID_KEY = 'test-dashscope-api-key';
const VALID_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const VALID_MODEL = 'qwen3.7-plus';
const VALID_ENV = {
  AI_PROVIDER: 'qwen',
  DASHSCOPE_API_KEY: VALID_KEY,
  QWEN_BASE_URL: VALID_BASE_URL,
  QWEN_MODEL: VALID_MODEL,
};

function assertNoSecrets(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(VALID_KEY), false);
  assert.equal(text.includes(VALID_BASE_URL), false);
  assert.equal(text.includes(VALID_MODEL), false);
  assert.equal(text.includes('DASHSCOPE_API_KEY'), false);
  assert.equal(text.includes('Authorization'), false);
}

test('accepts a valid qwen configuration without exposing secrets in public flags', () => {
  const config = getServerConfig({
    ...VALID_ENV,
    QWEN_BASE_URL: `${VALID_BASE_URL}/`,
  });

  assert.equal(config.hasQwenAiProvider, true);
  assert.equal(config.qwenApiKey, VALID_KEY);
  assert.equal(config.qwenBaseUrl, VALID_BASE_URL);
  assert.equal(config.qwenModel, VALID_MODEL);
  assert.equal(config.qwenRequestTimeoutMs, 60000);
  assert.equal(config.hasQwenAiProvider && 'qwenAi' in config, false);
  assertNoSecrets({
    hasQwenAiProvider: config.hasQwenAiProvider,
    hasAmapWebServiceKey: config.hasAmapWebServiceKey,
    port: config.port,
  });
});

test('treats missing key, model, unknown provider, and invalid URLs as unconfigured', () => {
  const cases: NodeJS.ProcessEnv[] = [
    { ...VALID_ENV, DASHSCOPE_API_KEY: '' },
    { ...VALID_ENV, DASHSCOPE_API_KEY: '   ' },
    { ...VALID_ENV, QWEN_MODEL: '' },
    { ...VALID_ENV, AI_PROVIDER: 'openai' },
    { ...VALID_ENV, AI_PROVIDER: '' },
    { ...VALID_ENV, QWEN_BASE_URL: 'http://dashscope.aliyuncs.com/compatible-mode/v1' },
    { ...VALID_ENV, QWEN_BASE_URL: 'https://example.com/compatible-mode/v1' },
    { ...VALID_ENV, QWEN_BASE_URL: 'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1' },
    { ...VALID_ENV, QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1?foo=1' },
    { ...VALID_ENV, QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1#frag' },
    { ...VALID_ENV, QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/../secret' },
    {},
  ];

  for (const env of cases) {
    const config = getServerConfig(env);
    assert.equal(config.hasQwenAiProvider, false);
    assert.equal(config.qwenApiKey, undefined);
    assert.equal(config.qwenBaseUrl, undefined);
    assert.equal(config.qwenModel, undefined);
    assertNoSecrets(config.hasQwenAiProvider);
  }
});

test('allows a trusted Beijing business-space host', () => {
  const config = getServerConfig({
    ...VALID_ENV,
    QWEN_BASE_URL: 'https://coding-intl.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  });
  assert.equal(config.hasQwenAiProvider, true);
  assert.equal(
    config.qwenBaseUrl,
    'https://coding-intl.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  );
});

test('does not leak the test key from config serialization of public fields', () => {
  const config = getServerConfig(VALID_ENV);
  const publicView = {
    hasQwenAiProvider: config.hasQwenAiProvider,
    hasAmapWebServiceKey: config.hasAmapWebServiceKey,
    hasAmapSecurityJsCode: config.hasAmapSecurityJsCode,
  };
  const serialized = JSON.stringify(publicView);
  assert.equal(serialized.includes(VALID_KEY), false);
  assert.equal(serialized.includes(VALID_BASE_URL), false);
  assert.equal(serialized.includes(VALID_MODEL), false);
  assert.equal(serialized.includes('qwenRequestTimeoutMs'), false);
  assert.equal(serialized.includes('60000'), false);
  assert.equal('qwenRequestTimeoutMs' in publicView, false);
  assert.equal('qwenApiKey' in publicView, false);
  assert.equal('qwenBaseUrl' in publicView, false);
  assert.equal('qwenModel' in publicView, false);
});

test('factory creates a Qwen provider only when configuration is complete', () => {
  const configured = getServerConfig(VALID_ENV);
  const missing = getServerConfig({});
  const fakeFetch = async () => new Response('{}');

  const provider = createAiProvider(configured, fakeFetch);
  assert.equal(provider instanceof QwenAiProvider, true);
  assert.equal(
    (provider as unknown as { timeoutMs: number }).timeoutMs,
    60000,
  );
  assert.equal(createAiProvider(missing, fakeFetch), undefined);
});

test('parses qwen request timeout with a 60000 default and safe bounds', () => {
  assert.equal(getServerConfig(VALID_ENV).qwenRequestTimeoutMs, 60000);
  assert.equal(getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '   ',
  }).qwenRequestTimeoutMs, 60000);
  assert.equal(getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '',
  }).qwenRequestTimeoutMs, 60000);

  assert.equal(getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '5000',
  }).qwenRequestTimeoutMs, 5000);
  assert.equal(getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '60000',
  }).qwenRequestTimeoutMs, 60000);
  assert.equal(getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '120000',
  }).qwenRequestTimeoutMs, 120000);

  const invalid = ['4999', '120001', '60000.5', '-1', '0', 'abc', '60_000', '+60000'];
  for (const value of invalid) {
    const config = getServerConfig({
      ...VALID_ENV,
      QWEN_REQUEST_TIMEOUT_MS: value,
    });
    assert.equal(config.qwenRequestTimeoutMs, 60000);
    assert.equal(config.hasQwenAiProvider, true);
  }
});

test('injects the configured qwen timeout into the provider constructor', () => {
  const config = getServerConfig({
    ...VALID_ENV,
    QWEN_REQUEST_TIMEOUT_MS: '45000',
  });
  const fakeFetch = async () => new Response('{}');
  const provider = createAiProvider(config, fakeFetch);
  assert.equal(config.hasQwenAiProvider, true);
  assert.equal(
    (provider as unknown as { timeoutMs: number }).timeoutMs,
    45000,
  );
});
