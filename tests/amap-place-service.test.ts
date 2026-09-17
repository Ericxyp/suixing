import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmapProviderError,
  type AmapHttpClient,
  type AmapQueryValue,
} from '../server/services/amap-http-client';
import { AmapWebServicePlaceService } from '../server/services/amap-place-service';

class FakeAmapHttpClient implements AmapHttpClient {
  calls: Array<{
    path: string;
    params: Record<string, AmapQueryValue>;
  }> = [];

  constructor(private readonly handler: () => Promise<unknown>) {}

  async get<T>(
    path: string,
    params: Record<string, AmapQueryValue>,
  ): Promise<T> {
    this.calls.push({
      path,
      params: { ...params },
    });
    return this.handler() as Promise<T>;
  }
}

const validPoi = {
  id: 'B001',
  name: '上海博物馆',
  address: '上海市黄浦区人民大道201号',
  location: '121.4748,31.2303',
  type: '风景名胜;博物馆',
};

test('searches places in a city and maps a valid POI', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [validPoi],
  }));
  const service = new AmapWebServicePlaceService(client);
  const input = {
    query: ' 上海博物馆 ',
    city: ' 上海 ',
    limit: 10,
  };

  const places = await service.search(input);

  assert.deepEqual(places, [
    {
      id: 'amap:B001',
      provider: 'amap',
      providerPlaceId: 'B001',
      name: '上海博物馆',
      address: '上海市黄浦区人民大道201号',
      longitude: 121.4748,
      latitude: 31.2303,
      category: 'attraction',
    },
  ]);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/v3/place/text');
  assert.deepEqual(client.calls[0].params, {
    keywords: '上海博物馆',
    city: '上海',
    citylimit: true,
    offset: 10,
    page: 1,
    extensions: 'base',
  });
  assert.equal('key' in client.calls[0].params, false);
  assert.equal('jscode' in client.calls[0].params, false);
  assert.equal('sig' in client.calls[0].params, false);
  assert.equal('callback' in client.calls[0].params, false);
  assert.deepEqual(input, {
    query: ' 上海博物馆 ',
    city: ' 上海 ',
    limit: 10,
  });
});

test('omits city and citylimit when city is not provided', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [],
  }));
  const service = new AmapWebServicePlaceService(client);

  await service.search({ query: '外滩', limit: 5 });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/v3/place/text');
  assert.equal('city' in client.calls[0].params, false);
  assert.equal('citylimit' in client.calls[0].params, false);
  assert.deepEqual(client.calls[0].params, {
    keywords: '外滩',
    offset: 5,
    page: 1,
    extensions: 'base',
  });
});

test('returns an empty list when there are no POIs', async () => {
  const emptyPois = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [],
  }));
  const missingPois = new FakeAmapHttpClient(async () => ({
    status: '1',
  }));

  assert.deepEqual(
    await new AmapWebServicePlaceService(emptyPois).search({
      query: '外滩',
      limit: 5,
    }),
    [],
  );
  assert.deepEqual(
    await new AmapWebServicePlaceService(missingPois).search({
      query: '外滩',
      limit: 5,
    }),
    [],
  );
});

test('keeps valid POIs and skips invalid ones without failing the search', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [
      validPoi,
      { name: '无 ID', location: '121.47,31.23' },
      { id: 'B002', name: '非法坐标', location: 'invalid' },
    ],
  }));
  const service = new AmapWebServicePlaceService(client);

  const places = await service.search({ query: '上海', city: '上海', limit: 10 });

  assert.equal(places.length, 1);
  assert.equal(places[0].providerPlaceId, 'B001');
});

test('converts Amap business failures without leaking upstream info', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '0',
    info: 'SOME_UPSTREAM_MESSAGE',
  }));
  const service = new AmapWebServicePlaceService(client);

  await assert.rejects(
    () => service.search({ query: '外滩', limit: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, '地点服务暂时不可用，请稍后重试。');
      assert.equal(error.message.includes('SOME_UPSTREAM_MESSAGE'), false);
      assert.equal(String(error).includes('SOME_UPSTREAM_MESSAGE'), false);
      return true;
    },
  );
});

test('preserves AmapProviderError thrown by the HTTP client', async () => {
  const client = new FakeAmapHttpClient(async () => {
    throw new AmapProviderError('PROVIDER_UNAVAILABLE', '地点服务尚未配置。');
  });
  const service = new AmapWebServicePlaceService(client);

  await assert.rejects(
    () => service.search({ query: '外滩', limit: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.message, '地点服务尚未配置。');
      return true;
    },
  );
});

test('loads a place detail by providerPlaceId', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [validPoi],
  }));
  const service = new AmapWebServicePlaceService(client);
  const id = 'B001';

  const place = await service.getByProviderPlaceId(id);

  assert.deepEqual(place, {
    id: 'amap:B001',
    provider: 'amap',
    providerPlaceId: 'B001',
    name: '上海博物馆',
    address: '上海市黄浦区人民大道201号',
    longitude: 121.4748,
    latitude: 31.2303,
    category: 'attraction',
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/v3/place/detail');
  assert.deepEqual(client.calls[0].params, {
    id: 'B001',
    extensions: 'base',
  });
  assert.equal('key' in client.calls[0].params, false);
  assert.equal(id, 'B001');
});

test('returns null when detail pois are empty or missing', async () => {
  const emptyPois = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [],
  }));
  const missingPois = new FakeAmapHttpClient(async () => ({
    status: '1',
  }));

  assert.equal(
    await new AmapWebServicePlaceService(emptyPois).getByProviderPlaceId('B001'),
    null,
  );
  assert.equal(
    await new AmapWebServicePlaceService(missingPois).getByProviderPlaceId('B001'),
    null,
  );
});

test('skips invalid detail POIs and returns the first mappable place', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [
      { name: '无 ID', location: '121.47,31.23' },
      validPoi,
    ],
  }));
  const service = new AmapWebServicePlaceService(client);

  const place = await service.getByProviderPlaceId('B001');

  assert.equal(place?.providerPlaceId, 'B001');
});

test('returns null when every detail POI is invalid', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [{ name: '无 ID', location: '121.47,31.23' }],
  }));
  const service = new AmapWebServicePlaceService(client);

  assert.equal(await service.getByProviderPlaceId('B001'), null);
});

test('rejects illegal providerPlaceIds before calling the client', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '1',
    pois: [validPoi],
  }));
  const service = new AmapWebServicePlaceService(client);

  for (const id of [
    '',
    '   ',
    'amap:B001',
    'B001/extra',
    '../secret',
    'https://restapi.amap.com/v3/place/detail',
    'B'.repeat(65),
    'B001?x=1',
    'B001#frag',
    'B001%2F',
  ]) {
    await assert.rejects(
      () => service.getByProviderPlaceId(id),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        return true;
      },
    );
  }

  assert.equal(client.calls.length, 0);
});

test('converts detail business failures without leaking upstream info', async () => {
  const client = new FakeAmapHttpClient(async () => ({
    status: '0',
    info: 'SOME_UPSTREAM_MESSAGE',
  }));
  const service = new AmapWebServicePlaceService(client);

  await assert.rejects(
    () => service.getByProviderPlaceId('B001'),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, '地点服务暂时不可用，请稍后重试。');
      assert.equal(error.message.includes('SOME_UPSTREAM_MESSAGE'), false);
      return true;
    },
  );
});

test('preserves HTTP client errors when loading place detail', async () => {
  const client = new FakeAmapHttpClient(async () => {
    throw new AmapProviderError('PROVIDER_UNAVAILABLE', '地点服务尚未配置。');
  });
  const service = new AmapWebServicePlaceService(client);

  await assert.rejects(
    () => service.getByProviderPlaceId('B001'),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.message, '地点服务尚未配置。');
      return true;
    },
  );
});
