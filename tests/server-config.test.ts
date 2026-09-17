import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerConfig } from '../server/config';

test('server config validates port and never exposes values', () => {
  assert.deepEqual(getServerConfig({}), {
    port: 3000,
    amapWebServiceKey: undefined,
    amapSecurityJsCode: undefined,
    hasAmapWebServiceKey: false,
    hasAmapSecurityJsCode: false,
    qwenApiKey: undefined,
    qwenBaseUrl: undefined,
    qwenModel: undefined,
    qwenRequestTimeoutMs: 60000,
    hasQwenAiProvider: false,
  });
  assert.equal(getServerConfig({ PORT: '4567' }).port, 4567);
  for (const port of ['0', '-1', 'abc', '70000', '3000.5']) assert.equal(getServerConfig({ PORT: port }).port, 3000);
  assert.equal(getServerConfig({ AMAP_WEB_SERVICE_KEY: '   ' }).amapWebServiceKey, undefined);
  const config = getServerConfig({ AMAP_WEB_SERVICE_KEY: 'test-web-service-key', AMAP_SECURITY_JS_CODE: 'test-code' });
  assert.equal(config.amapWebServiceKey, 'test-web-service-key');
  assert.equal(config.amapSecurityJsCode, 'test-code');
  assert.equal(config.hasAmapWebServiceKey, true);
  assert.equal(config.hasAmapSecurityJsCode, true);
  assert.equal(config.hasQwenAiProvider, false);
});
