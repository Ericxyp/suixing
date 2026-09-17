import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, TransportMode } from '../src/domain/trip/types';
import {
  AmapRouteProvider,
  DEFAULT_ROUTE_MODE,
} from '../src/providers/amap-route-provider';
import { MockRouteProvider } from '../src/providers/mock-providers';
import { BffClientError, BffHttpClient, type FetchLike } from '../src/services/bff-client';

const from: Place = {
  id: 'amap:from',
  provider: 'amap',
  providerPlaceId: 'from',
  name: '起点',
  address: '上海市',
  latitude: 31.23,
  longitude: 121.47,
  category: 'attraction',
};

const to: Place = {
  id: 'amap:to',
  provider: 'amap',
  providerPlaceId: 'to',
  name: '终点',
  address: '上海市',
  latitude: 31.24,
  longitude: 121.49,
  category: 'cafe',
};

const routeResult = {
  transport: {
    mode: 'walk' as const,
    durationMinutes: 12,
    distanceMeters: 850,
  },
  polyline: [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.24, longitude: 121.49 },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createProvider(fakeFetch: FetchLike): AmapRouteProvider {
  return new AmapRouteProvider(new BffHttpClient(fakeFetch));
}

test('builds relative /api/routes parameters without reversing coordinates', async () => {
  const captured: string[] = [];
  const fakeFetch: FetchLike = async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { route: routeResult } });
  };
  const provider = createProvider(fakeFetch);
  const fromInput = structuredClone(from);
  const toInput = structuredClone(to);

  const result = await provider.getRouteResult({
    from: fromInput,
    to: toInput,
    mode: 'walk',
  });

  assert.deepEqual(result, routeResult);
  assert.equal(captured.length, 1);
  const url = new URL(captured[0], 'http://frontend.local');
  assert.equal(url.pathname, '/api/routes');
  assert.equal(url.searchParams.get('originLng'), '121.47');
  assert.equal(url.searchParams.get('originLat'), '31.23');
  assert.equal(url.searchParams.get('destinationLng'), '121.49');
  assert.equal(url.searchParams.get('destinationLat'), '31.24');
  assert.equal(url.searchParams.get('mode'), 'walk');
  assert.deepEqual(fromInput, from);
  assert.deepEqual(toInput, to);
});

test('walk and taxi modes are forwarded to the BFF', async () => {
  const modes: TransportMode[] = [];
  const fakeFetch: FetchLike = async (input) => {
    const url = new URL(String(input), 'http://frontend.local');
    modes.push(url.searchParams.get('mode') as TransportMode);
    const mode = url.searchParams.get('mode') === 'taxi' ? 'taxi' : 'walk';
    return jsonResponse({
      data: {
        route: {
          ...routeResult,
          transport: { ...routeResult.transport, mode },
        },
      },
    });
  };
  const provider = createProvider(fakeFetch);

  const walking = await provider.getRoute({ from, to, mode: 'walk' });
  const taxi = await provider.getRouteResult({ from, to, mode: 'taxi' });

  assert.deepEqual(modes, ['walk', 'taxi']);
  assert.equal(walking.mode, 'walk');
  assert.equal(taxi.transport.mode, 'taxi');
  assert.deepEqual(taxi.polyline, routeResult.polyline);
});

test('uses a documented walk default when mode is omitted', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { route: routeResult } });
  });

  const transport = await provider.getRoute({ from, to });

  assert.equal(DEFAULT_ROUTE_MODE, 'walk');
  assert.equal(transport.mode, 'walk');
  const url = new URL(captured[0], 'http://frontend.local');
  assert.equal(url.searchParams.get('mode'), 'walk');
});

test('unsupported modes do not send a request', async () => {
  const captured: string[] = [];
  const provider = createProvider(async (input) => {
    captured.push(String(input));
    return jsonResponse({ data: { route: routeResult } });
  });

  for (const mode of ['metro', 'bus', 'drive'] as const) {
    await assert.rejects(
      () => provider.getRoute({ from, to, mode }),
      (error: unknown) => {
        assert.ok(error instanceof BffClientError);
        assert.equal(error.code, 'INVALID_REQUEST');
        return true;
      },
    );
  }

  assert.deepEqual(captured, []);
});

test('getRoute returns only transport while getRouteResult keeps the polyline', async () => {
  const provider = createProvider(async () =>
    jsonResponse({ data: { route: routeResult } }),
  );

  const transport = await provider.getRoute({ from, to, mode: 'walk' });
  const result = await provider.getRouteResult({ from, to, mode: 'walk' });

  assert.deepEqual(transport, routeResult.transport);
  assert.deepEqual(result, routeResult);
  transport.durationMinutes = 0;
  result.polyline[0].latitude = 0;
  const again = await provider.getRouteResult({ from, to, mode: 'walk' });
  assert.equal(again.transport.durationMinutes, 12);
  assert.equal(again.polyline[0].latitude, 31.23);
});

test('maps BFF route errors to stable client errors without leaking bodies', async () => {
  const provider = createProvider(async () =>
    jsonResponse(
      {
        error: {
          code: 'PROVIDER_ERROR',
          message: '路线服务暂时不可用，请稍后重试。',
          info: 'RAW_AMAP_DTO',
        },
      },
      502,
    ),
  );

  await assert.rejects(
    () => provider.getRoute({ from, to, mode: 'walk' }),
    (error: unknown) => {
      assert.ok(error instanceof BffClientError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, '路线服务暂时不可用，请稍后重试。');
      assert.equal(error.message.includes('RAW_AMAP_DTO'), false);
      return true;
    },
  );
});

test('MockRouteProvider still resolves the existing Shanghai mock route', async () => {
  const mock = new MockRouteProvider();
  const indigo: Place = {
    id: 'place-indigo-shanghai',
    provider: 'mock',
    providerPlaceId: 'mock-sh-001',
    name: '上海外滩英迪格酒店',
    address: '上海市黄浦区中山东二路585号',
    latitude: 31.2352,
    longitude: 121.4902,
    category: 'hotel',
  };
  const wukang: Place = {
    id: 'place-wukang-road',
    provider: 'mock',
    providerPlaceId: 'mock-sh-002',
    name: '武康路',
    address: '上海市徐汇区武康路',
    latitude: 31.2077,
    longitude: 121.4361,
    category: 'attraction',
  };

  const transport = await mock.getRoute({
    from: indigo,
    to: wukang,
    mode: 'taxi',
  });

  assert.equal(transport.mode, 'taxi');
  assert.ok(transport.durationMinutes > 0);
});
