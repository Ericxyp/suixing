import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import type { AmapPlaceService } from '../server/services/amap-place-service';
import type { Place } from '../src/domain/trip/types';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

function restaurant(): Place {
  return {
    id: 'amap:R1',
    provider: 'amap',
    providerPlaceId: 'R1',
    name: '东四小馆',
    address: '北京市东城区',
    latitude: 39.901,
    longitude: 116.401,
    category: 'restaurant',
  };
}

async function post(body: unknown, service?: AmapPlaceService): Promise<{ status: number; json: unknown }> {
  const server = createServer(createApp(config, {
    placeSearchService: service,
  }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('no port');
  }
  const response = await fetch(`http://127.0.0.1:${address.port}/api/trips/meal-options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return { status: response.status, json };
}

test('meal options route rejects complete trips and secrets', async () => {
  const result = await post({
    city: '北京',
    mealPeriod: 'lunch',
    area: { placeId: 'amap:AREA', name: '东四附近', longitude: 116.4, latitude: 39.9 },
    trip: { id: 'trip-1' },
    key: 'secret',
  });
  assert.equal(result.status, 400);
});

test('meal options route returns internal places only', async () => {
  const service: AmapPlaceService = {
    async search() {
      return [restaurant()];
    },
    async getByProviderPlaceId() {
      return restaurant();
    },
  };
  const result = await post({
    city: '北京',
    mealPeriod: 'lunch',
    area: { placeId: 'amap:AREA', name: '东四附近', longitude: 116.4, latitude: 39.9 },
  }, service);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    data: {
      places: [restaurant()],
    },
  });
  assert.equal(JSON.stringify(result.json).includes('restapi'), false);
});
