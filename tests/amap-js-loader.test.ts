import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  AmapJsApiLoadError,
  createAmapJsApiLoader,
  type AmapJsApi,
  type AmapJsLoaderAdapter,
  type AmapLoaderScript,
} from '../src/services/amap-js-loader';

class FakeScript implements AmapLoaderScript {
  id = '';
  async = false;
  src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removed = false;

  remove(): void {
    this.removed = true;
  }
}

function fakeAmap(): AmapJsApi {
  return { marker: 'same-amap-object' } as unknown as AmapJsApi;
}

function createFakeAdapter(apiKey?: string) {
  const state: {
    amap?: AmapJsApi;
    config?: { serviceHost: string };
    scripts: FakeScript[];
    events: string[];
    keyReads: number;
  } = {
    scripts: [],
    events: [],
    keyReads: 0,
  };

  const adapter: AmapJsLoaderAdapter = {
    getApiKey() {
      state.keyReads += 1;
      return apiKey;
    },
    getAmap() {
      return state.amap;
    },
    setSecurityConfig(config) {
      state.events.push('security-config');
      state.config = { ...config };
    },
    createScript() {
      const script = new FakeScript();
      state.scripts.push(script);
      return script;
    },
    appendScript() {
      state.events.push('append-script');
    },
  };

  return { adapter, state };
}

function assertSafeLoaderError(
  error: unknown,
  code:
    | 'AMAP_JS_API_KEY_MISSING'
    | 'AMAP_JS_API_LOAD_FAILED'
    | 'AMAP_JS_API_GLOBAL_MISSING',
): boolean {
  assert.ok(error instanceof AmapJsApiLoadError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes('PRIVATE JS KEY'), false);
  assert.equal(error.message.includes('webapi.amap.com/maps'), false);
  assert.equal(error.message.includes('/_AMapService'), false);
  return true;
}

test('rejects missing and blank keys without touching security config or DOM', async () => {
  for (const key of [undefined, '', '   ']) {
    const { adapter, state } = createFakeAdapter(key);
    const load = createAmapJsApiLoader(adapter);

    await assert.rejects(
      () => load(),
      (error: unknown) => assertSafeLoaderError(
        error,
        'AMAP_JS_API_KEY_MISSING',
      ),
    );
    assert.equal(state.config, undefined);
    assert.equal(state.scripts.length, 0);
  }
});

test('sets serviceHost before inserting one async AMap 2.0 script', async () => {
  const { adapter, state } = createFakeAdapter(' PRIVATE JS KEY&value ');
  const load = createAmapJsApiLoader(adapter);
  const loading = load();
  await Promise.resolve();

  assert.deepEqual(state.events, ['security-config', 'append-script']);
  assert.deepEqual(state.config, { serviceHost: '/_AMapService' });
  assert.equal(state.scripts.length, 1);
  const script = state.scripts[0];
  assert.equal(script.id, 'amap-js-api-v2');
  assert.equal(script.async, true);
  assert.equal(
    script.src,
    'https://webapi.amap.com/maps?v=2.0&key=PRIVATE%20JS%20KEY%26value',
  );
  assert.equal(script.src.includes('jscode'), false);
  assert.equal(script.src.includes('securityJsCode'), false);

  const amap = fakeAmap();
  state.amap = amap;
  script.onload?.();
  assert.equal(await loading, amap);
});

test('deduplicates concurrent calls and resolves all callers to one AMap object', async () => {
  const { adapter, state } = createFakeAdapter('test-key');
  const load = createAmapJsApiLoader(adapter);

  const first = load();
  const second = load();
  const third = load();
  assert.equal(first, second);
  assert.equal(second, third);
  await Promise.resolve();
  assert.equal(state.scripts.length, 1);

  const amap = fakeAmap();
  state.amap = amap;
  state.scripts[0].onload?.();
  const loaded = await Promise.all([first, second, third]);
  assert.equal(loaded[0], amap);
  assert.equal(loaded[1], amap);
  assert.equal(loaded[2], amap);
});

test('returns an existing window AMap without reading the key or inserting a script', async () => {
  const { adapter, state } = createFakeAdapter(undefined);
  const amap = fakeAmap();
  state.amap = amap;
  const load = createAmapJsApiLoader(adapter);

  assert.equal(await load(), amap);
  assert.equal(state.keyReads, 0);
  assert.equal(state.scripts.length, 0);
  assert.equal(state.config, undefined);
});

test('returns a stable script error and allows a later retry', async () => {
  const { adapter, state } = createFakeAdapter('PRIVATE JS KEY');
  const load = createAmapJsApiLoader(adapter);

  const first = load();
  await Promise.resolve();
  state.scripts[0].onerror?.();
  await assert.rejects(
    first,
    (error: unknown) => assertSafeLoaderError(
      error,
      'AMAP_JS_API_LOAD_FAILED',
    ),
  );
  assert.equal(state.scripts[0].removed, true);

  const second = load();
  await Promise.resolve();
  assert.equal(state.scripts.length, 2);
  const amap = fakeAmap();
  state.amap = amap;
  state.scripts[1].onload?.();
  assert.equal(await second, amap);
});

test('rejects a missing AMap global after load and can retry', async () => {
  const { adapter, state } = createFakeAdapter('PRIVATE JS KEY');
  const load = createAmapJsApiLoader(adapter);

  const first = load();
  await Promise.resolve();
  state.scripts[0].onload?.();
  await assert.rejects(
    first,
    (error: unknown) => assertSafeLoaderError(
      error,
      'AMAP_JS_API_GLOBAL_MISSING',
    ),
  );
  assert.equal(state.scripts[0].removed, true);

  const second = load();
  await Promise.resolve();
  assert.equal(state.scripts.length, 2);
  const amap = fakeAmap();
  state.amap = amap;
  state.scripts[1].onload?.();
  assert.equal(await second, amap);
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return /\.(?:ts|tsx|js)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

test('frontend source contains no server-only AMap credential names', async () => {
  const sourceRoot = path.resolve('src');
  const files = await listSourceFiles(sourceRoot);
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));

  for (const source of contents) {
    assert.equal(source.includes('AMAP_WEB_SERVICE_KEY'), false);
    assert.equal(source.includes('AMAP_SECURITY_JS_CODE'), false);
    assert.equal(source.includes('securityJsCode'), false);
    assert.equal(source.includes('DASHSCOPE_API_KEY'), false);
    assert.equal(source.includes('QWEN_BASE_URL'), false);
    assert.equal(source.includes('QWEN_MODEL'), false);
    assert.equal(source.includes('QWEN_REQUEST_TIMEOUT_MS'), false);
    assert.equal(source.includes('compatible-mode'), false);
    assert.equal(source.includes('json_schema'), false);
  }
});
