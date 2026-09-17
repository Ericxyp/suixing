import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { AmapProviderError } from '../server/services/amap-http-client';
import type { AmapPlaceService, PlaceSearchInput } from '../server/services/amap-place-service';
import type { Place } from '../src/domain/trip/types';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const museum: Place = {
  id: 'amap:B001',
  provider: 'amap',
  providerPlaceId: 'B001',
  name: '上海博物馆',
  address: '上海市黄浦区人民大道201号',
  longitude: 121.4748,
  latitude: 31.2303,
  category: 'attraction',
};

class FakePlaceService implements AmapPlaceService {
  calls: PlaceSearchInput[] = [];

  constructor(
    private readonly handler: (input: PlaceSearchInput) => Promise<Place[]> = async () => [
      museum,
    ],
  ) {}

  async search(input: PlaceSearchInput): Promise<Place[]> {
    this.calls.push({ ...input });
    return this.handler(input);
  }

  async getByProviderPlaceId(_providerPlaceId: string): Promise<Place | null> {
    return null;
  }
}

async function request(
  path: string,
  options: {
    method?: string;
    placeSearchService?: AmapPlaceService;
  } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(createApp(config, { placeSearchService: options.placeSearchService }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? 'GET',
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as unknown, text };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function assertNoSensitiveLeak(text: string): void {
  assert.equal(text.includes('test-amap-web-service-key'), false);
  assert.equal(text.includes('restapi.amap.com'), false);
  assert.equal(text.includes('typecode'), false);
  assert.equal(text.includes('SOME_UPSTREAM_MESSAGE'), false);
  assert.equal(text.includes('pois'), false);
  assert.equal(text.includes('location'), false);
}

test('searches places and returns internal Place data', async () => {
  const service = new FakePlaceService();
  const result = await request(
    '/api/places/search?query=%20%E4%B8%8A%E6%B5%B7%E5%8D%9A%E7%89%A9%E9%A6%86%20&city=%20%E4%B8%8A%E6%B5%B7%20&limit=8',
    { placeSearchService: service },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { places: [museum] } });
  assert.deepEqual(service.calls, [{ query: '上海博物馆', city: '上海', limit: 8 }]);
  assertNoSensitiveLeak(result.text);
});

test('omits city when it is missing or blank', async () => {
  const service = new FakePlaceService();
  const missing = await request('/api/places/search?query=%E5%A4%96%E6%BB%A9', {
    placeSearchService: service,
  });
  const blank = await request('/api/places/search?query=%E5%A4%96%E6%BB%A9&city=%20%20', {
    placeSearchService: service,
  });

  assert.equal(missing.status, 200);
  assert.equal(blank.status, 200);
  assert.deepEqual(service.calls[0], { query: '外滩', limit: 10 });
  assert.equal('city' in service.calls[0], false);
  assert.deepEqual(service.calls[1], { query: '外滩', limit: 10 });
  assert.equal('city' in service.calls[1], false);
});

test('defaults limit to 10', async () => {
  const service = new FakePlaceService();
  await request('/api/places/search?query=%E5%A4%96%E6%BB%A9', { placeSearchService: service });
  assert.equal(service.calls[0].limit, 10);
});

test('rejects empty query, illegal limit, and duplicate query parameters', async () => {
  const service = new FakePlaceService();
  const cases = [
    '/api/places/search',
    '/api/places/search?query=%20',
    '/api/places/search?query=%E5%A4%96%E6%BB%A9&limit=abc',
    '/api/places/search?query=%E5%A4%96%E6%BB%A9&limit=0',
    '/api/places/search?query=%E5%A4%96%E6%BB%A9&limit=21',
    '/api/places/search?query=%E5%A4%96%E6%BB%A9&limit=10.5',
    '/api/places/search?query=%E5%A4%96%E6%BB%A9&query=%E4%B8%8A%E6%B5%B7%E5%8D%9A%E7%89%A9%E9%A6%86',
    `/api/places/search?query=${'博'.repeat(101)}`,
    '/api/places/search?query[foo]=%E5%A4%96%E6%BB%A9',
  ];

  for (const path of cases) {
    const result = await request(path, { placeSearchService: service });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '搜索条件无效，请调整后重试。' },
    });
    assertNoSensitiveLeak(result.text);
  }

  assert.equal(service.calls.length, 0);
});

test('does not forward protected Amap parameters to the service', async () => {
  const service = new FakePlaceService();
  const result = await request(
    '/api/places/search?query=%E4%B8%8A%E6%B5%B7%E5%8D%9A%E7%89%A9%E9%A6%86&key=secret-key&jscode=secret-js&sig=secret-sig&callback=cb',
    { placeSearchService: service },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(service.calls, [{ query: '上海博物馆', limit: 10 }]);
  assert.equal('key' in service.calls[0], false);
  assert.equal('jscode' in service.calls[0], false);
  assert.equal('sig' in service.calls[0], false);
  assert.equal('callback' in service.calls[0], false);
  assert.equal(result.text.includes('secret-key'), false);
  assert.equal(result.text.includes('secret-js'), false);
});

test('returns 503 when the place search service is not injected', async () => {
  const result = await request('/api/places/search?query=%E5%A4%96%E6%BB%A9');
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: { code: 'PROVIDER_UNAVAILABLE', message: '地点服务尚未配置。' },
  });
  assertNoSensitiveLeak(result.text);
});

test('maps AmapProviderError codes to stable HTTP responses', async () => {
  const cases: Array<{
    error: AmapProviderError;
    status: number;
  }> = [
    {
      error: new AmapProviderError('INVALID_REQUEST', '不允许传入受保护的高德请求参数。'),
      status: 400,
    },
    {
      error: new AmapProviderError('PROVIDER_ERROR', '地点服务暂时不可用，请稍后重试。'),
      status: 502,
    },
    {
      error: new AmapProviderError('PROVIDER_UNAVAILABLE', '地点服务尚未配置。'),
      status: 503,
    },
  ];

  for (const { error, status } of cases) {
    const service = new FakePlaceService(async () => {
      throw error;
    });
    const result = await request('/api/places/search?query=%E5%A4%96%E6%BB%A9', {
      placeSearchService: service,
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.body, { error: { code: error.code, message: error.message } });
    assertNoSensitiveLeak(result.text);
  }
});

test('non-GET methods receive a JSON 405', async () => {
  const service = new FakePlaceService();
  const result = await request('/api/places/search?query=%E5%A4%96%E6%BB%A9', {
    method: 'POST',
    placeSearchService: service,
  });
  assert.equal(result.status, 405);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '仅支持搜索地点。' },
  });
  assert.equal(service.calls.length, 0);
});
