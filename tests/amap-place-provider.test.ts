import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place } from '../src/domain/trip/types';
import { AmapPlaceProvider, PLACE_SEARCH_LIMIT } from '../src/providers/amap-place-provider';
import { MockPlaceProvider, MockRouteProvider } from '../src/providers/mock-providers';
import {
  createAmapTravelProviders,
  createMockTravelProviders,
  defaultTravelProviders,
} from '../src/providers/travel-providers';
import { BffClientError, BffHttpClient, type FetchLike } from '../src/services/bff-client';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createProvider(fakeFetch: FetchLike): AmapPlaceProvider {
  return new AmapPlaceProvider(new BffHttpClient(fakeFetch));
}

test('trims and encodes place search query and city', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { places: [museum] } });
  };
  const provider = createProvider(fakeFetch);
  const query = '  上海博物馆  ';
  const city = '  上海  ';

  const places = await provider.search(query, city);

  assert.deepEqual(places, [museum]);
  assert.equal(captured.length, 1);
  const url = new URL(captured[0], 'http://frontend.local');
  assert.equal(url.pathname, '/api/places/search');
  assert.equal(url.searchParams.get('query'), '上海博物馆');
  assert.equal(url.searchParams.get('city'), '上海');
  assert.equal(url.searchParams.get('limit'), String(PLACE_SEARCH_LIMIT));
  assert.equal(query, '  上海博物馆  ');
  assert.equal(city, '  上海  ');
});

test('omits a blank city and does not send extra fields', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { places: [] } });
  };
  const provider = createProvider(fakeFetch);

  await provider.search('博物馆', '   ');

  const url = new URL(captured[0], 'http://frontend.local');
  assert.equal(url.searchParams.get('query'), '博物馆');
  assert.equal(url.searchParams.has('city'), false);
  assert.equal(url.searchParams.get('limit'), '10');
});

test('rejects a blank query before fetch', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { places: [] } });
  });

  await assert.rejects(
    () => provider.search('   '),
    (error: unknown) => {
      assert.ok(error instanceof BffClientError);
      assert.equal(error.code, 'INVALID_REQUEST');
      return true;
    },
  );
  assert.deepEqual(captured, []);
});

test('returns cloned internal Place data and ignores extra DTO fields', async () => {
  const payloadPlace = {
    ...museum,
    typecode: '140000',
    location: '121.4748,31.2303',
  };
  const provider = createProvider(async () =>
    jsonResponse({ data: { places: [payloadPlace] } }),
  );

  const places = await provider.search('上海博物馆', '上海');

  assert.deepEqual(places, [museum]);
  assert.equal('typecode' in places[0], false);
  assert.equal('location' in places[0], false);
  places[0].name = 'mutated';
  payloadPlace.name = 'mutated-payload';
});

test('rejects an invalid place search response', async () => {
  const provider = createProvider(async () =>
    jsonResponse({ data: { places: [{ id: 'bad' }] } }),
  );

  await assert.rejects(
    () => provider.search('上海博物馆'),
    (error: unknown) => {
      assert.ok(error instanceof BffClientError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.message.includes('typecode'), false);
      return true;
    },
  );
});

test('getById calls the BFF detail path and returns a cloned Place', async () => {
  const captured: string[] = [];
  const payloadPlace = {
    ...museum,
    typecode: '140000',
  };
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { place: structuredClone(payloadPlace) } });
  });
  const id = 'B001';

  const place = await provider.getById(id);

  assert.deepEqual(place, museum);
  assert.equal('typecode' in (place ?? {}), false);
  assert.deepEqual(captured, ['/api/places/B001']);
  assert.equal(id, 'B001');
  if (place) {
    place.name = 'mutated';
  }
  const again = await provider.getById('B001');
  assert.equal(again?.name, '上海博物馆');
});

test('getById returns null when the BFF place is null', async () => {
  const provider = createProvider(async () =>
    jsonResponse({ data: { place: null } }),
  );

  assert.equal(await provider.getById('B001'), null);
});

test('getById does not fall back to search cache or Mock when BFF fails', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    const url = new URL(String(input), 'http://frontend.local');
    if (url.pathname === '/api/places/search') {
      return jsonResponse({ data: { places: [museum] } });
    }
    return jsonResponse(
      { error: { code: 'PROVIDER_ERROR', message: '地点服务暂时不可用，请稍后重试。' } },
      502,
    );
  });

  const searched = await provider.search('上海博物馆');
  assert.deepEqual(searched, [museum]);

  await assert.rejects(
    () => provider.getById('B001'),
    (error: unknown) => {
      assert.ok(error instanceof BffClientError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      return true;
    },
  );
  assert.equal(captured.includes('/api/places/B001'), true);
});

test('rejects an illegal providerPlaceId before fetch', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { place: museum } });
  });

  await assert.rejects(
    () => provider.getById('amap:B001'),
    (error: unknown) => {
      assert.ok(error instanceof BffClientError);
      assert.equal(error.code, 'INVALID_REQUEST');
      return true;
    },
  );
  assert.deepEqual(captured, []);
});

test('does not mutate BFF payloads or caller-visible search results', async () => {
  const payload = { data: { places: [structuredClone(museum)] } };
  const original = structuredClone(payload);
  const provider = createProvider(async () => jsonResponse(payload));

  const places = await provider.search('上海博物馆');
  places[0].latitude = 0;
  payload.data.places[0].longitude = 0;

  assert.deepEqual(original, { data: { places: [museum] } });
});

test('application default providers stay on Mock implementations', async () => {
  const mocked = createMockTravelProviders();
  const amap = createAmapTravelProviders({
    fetch: async () => jsonResponse({ data: { places: [] } }),
  });

  assert.equal(mocked.placeProvider instanceof MockPlaceProvider, true);
  assert.equal(mocked.routeProvider instanceof MockRouteProvider, true);
  assert.equal(defaultTravelProviders.placeProvider instanceof MockPlaceProvider, true);
  assert.equal(defaultTravelProviders.routeProvider instanceof MockRouteProvider, true);
  assert.equal(amap.placeProvider instanceof AmapPlaceProvider, true);
  assert.notEqual(amap.placeProvider, defaultTravelProviders.placeProvider);

  const mockResults = await mocked.placeProvider.search('上海博物馆');
  assert.equal(mockResults.some((place) => place.name === '上海博物馆'), true);
});
