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
  searchCalls: PlaceSearchInput[] = [];
  detailCalls: string[] = [];

  constructor(
    private readonly handler: (id: string) => Promise<Place | null> = async () => museum,
  ) {}

  async search(input: PlaceSearchInput): Promise<Place[]> {
    this.searchCalls.push({ ...input });
    return [];
  }

  async getByProviderPlaceId(providerPlaceId: string): Promise<Place | null> {
    this.detailCalls.push(providerPlaceId);
    return this.handler(providerPlaceId);
  }
}

async function request(
  path: string,
  options: {
    method?: string;
    placeSearchService?: AmapPlaceService;
  } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(
    createApp(config, { placeSearchService: options.placeSearchService }),
  );
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
    return {
      status: response.status,
      body: JSON.parse(text) as unknown,
      text,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function assertNoSensitiveLeak(text: string): void {
  for (const secret of [
    'test-amap-web-service-key',
    'restapi.amap.com',
    'typecode',
    'SOME_UPSTREAM_MESSAGE',
    'RAW_AMAP_DTO',
    'stack',
    'pois',
    'location',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('returns an internal Place for a valid providerPlaceId', async () => {
  const service = new FakePlaceService();
  const result = await request('/api/places/B001', {
    placeSearchService: service,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { place: museum } });
  assert.deepEqual(service.detailCalls, ['B001']);
  assert.equal(service.searchCalls.length, 0);
  assertNoSensitiveLeak(result.text);
});

test('returns place null when the location is not found', async () => {
  const service = new FakePlaceService(async () => null);
  const result = await request('/api/places/B001', {
    placeSearchService: service,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { place: null } });
  assert.deepEqual(service.detailCalls, ['B001']);
  assertNoSensitiveLeak(result.text);
});

test('rejects illegal path parameters without calling the service', async () => {
  const service = new FakePlaceService();
  const cases = [
    '/api/places/',
    '/api/places/amap:B001',
    '/api/places/B001/extra',
    `/api/places/${'B'.repeat(65)}`,
    '/api/places/B001%2Fhack',
    '/api/places/B001%3Axx',
    '/api/places/%20B001',
    '/api/places/https%3A%2F%2Fexample.com',
  ];

  for (const path of cases) {
    const result = await request(path, { placeSearchService: service });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: { code: 'INVALID_REQUEST', message: '地点编号无效，请调整后重试。' },
    });
    assertNoSensitiveLeak(result.text);
  }

  assert.equal(service.detailCalls.length, 0);
});

test('rejects protected query parameters without calling the service', async () => {
  const service = new FakePlaceService();
  const result = await request(
    '/api/places/B001?key=secret-key&jscode=secret-js&sig=secret-sig&callback=cb&url=https://example.com&target=x',
    { placeSearchService: service },
  );

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '地点编号无效，请调整后重试。' },
  });
  assert.equal(service.detailCalls.length, 0);
  assert.equal(result.text.includes('secret-key'), false);
  assert.equal(result.text.includes('secret-js'), false);
});

test('returns 503 when the place service is not injected', async () => {
  const result = await request('/api/places/B001');
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: { code: 'PROVIDER_UNAVAILABLE', message: '地点服务尚未配置。' },
  });
  assertNoSensitiveLeak(result.text);
});

test('maps AmapProviderError codes to stable HTTP responses', async () => {
  const cases: Array<{ error: AmapProviderError; status: number }> = [
    {
      error: new AmapProviderError('INVALID_REQUEST', '地点编号无效，请调整后重试。'),
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
    const result = await request('/api/places/B001', {
      placeSearchService: service,
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.body, {
      error: { code: error.code, message: error.message },
    });
    assertNoSensitiveLeak(result.text);
  }
});

test('non-GET methods receive a JSON 405', async () => {
  const service = new FakePlaceService();
  const result = await request('/api/places/B001', {
    method: 'POST',
    placeSearchService: service,
  });
  assert.equal(result.status, 405);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '仅支持查询地点详情。' },
  });
  assert.equal(service.detailCalls.length, 0);
});
