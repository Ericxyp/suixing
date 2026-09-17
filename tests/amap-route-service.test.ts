import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmapProviderError,
  type AmapHttpClient,
  type AmapQueryValue,
} from '../server/services/amap-http-client';
import {
  AmapWebServiceRouteService,
  type RoutePlanningInput,
} from '../server/services/amap-route-service';

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
    this.calls.push({ path, params: { ...params } });
    return this.handler() as Promise<T>;
  }
}

function routeResponse() {
  return {
    status: '1',
    route: {
      paths: [
        {
          distance: '1200',
          duration: '600',
          steps: [
            { polyline: '121.4737,31.2304;121.4837,31.2404' },
          ],
        },
      ],
    },
  };
}

test('plans a driving route with longitude,latitude parameters', async () => {
  const client = new FakeAmapHttpClient(async () => routeResponse());
  const service = new AmapWebServiceRouteService(client);
  const input: RoutePlanningInput = {
    origin: { latitude: 31.2304, longitude: 121.4737 },
    destination: { latitude: 31.2404, longitude: 121.4837 },
    mode: 'taxi',
  };

  const result = await service.plan(input);

  assert.deepEqual(client.calls, [
    {
      path: '/v3/direction/driving',
      params: {
        origin: '121.4737,31.2304',
        destination: '121.4837,31.2404',
      },
    },
  ]);
  assert.deepEqual(result, {
    transport: { mode: 'taxi', distanceMeters: 1200, durationMinutes: 10 },
    polyline: [
      { latitude: 31.2304, longitude: 121.4737 },
      { latitude: 31.2404, longitude: 121.4837 },
    ],
  });
  assert.deepEqual(input, {
    origin: { latitude: 31.2304, longitude: 121.4737 },
    destination: { latitude: 31.2404, longitude: 121.4837 },
    mode: 'taxi',
  });
});

test('plans a walking route through the walking endpoint', async () => {
  const client = new FakeAmapHttpClient(async () => routeResponse());
  const service = new AmapWebServiceRouteService(client);

  const result = await service.plan({
    origin: { latitude: 31.2304, longitude: 121.4737 },
    destination: { latitude: 31.2404, longitude: 121.4837 },
    mode: 'walk',
  });

  assert.equal(client.calls[0].path, '/v3/direction/walking');
  assert.deepEqual(client.calls[0].params, {
    origin: '121.4737,31.2304',
    destination: '121.4837,31.2404',
  });
  assert.equal(result.transport.mode, 'walk');
});

test('rejects missing, non-finite, out-of-range, and unsupported inputs before the client', async () => {
  const client = new FakeAmapHttpClient(async () => routeResponse());
  const service = new AmapWebServiceRouteService(client);
  const validOrigin = { latitude: 31.2304, longitude: 121.4737 };
  const validDestination = { latitude: 31.2404, longitude: 121.4837 };
  const invalidInputs: RoutePlanningInput[] = [
    { destination: validDestination, mode: 'walk' } as unknown as RoutePlanningInput,
    { origin: validOrigin, mode: 'walk' } as unknown as RoutePlanningInput,
    {
      origin: { latitude: 91, longitude: 121.4737 },
      destination: validDestination,
      mode: 'walk',
    },
    {
      origin: validOrigin,
      destination: { latitude: 31.2404, longitude: 181 },
      mode: 'taxi',
    },
    {
      origin: { latitude: Number.NaN, longitude: 121.4737 },
      destination: validDestination,
      mode: 'walk',
    },
    {
      origin: validOrigin,
      destination: { latitude: 31.2404, longitude: Number.POSITIVE_INFINITY },
      mode: 'taxi',
    },
    {
      origin: validOrigin,
      destination: validDestination,
      mode: 'metro',
    } as unknown as RoutePlanningInput,
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      () => service.plan(input),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.message, '路线参数无效，请调整后重试。');
        return true;
      },
    );
  }
  assert.equal(client.calls.length, 0);
});

test('preserves AmapProviderError from the HTTP client', async () => {
  const original = new AmapProviderError(
    'PROVIDER_UNAVAILABLE',
    '地点服务尚未配置。',
  );
  const client = new FakeAmapHttpClient(async () => {
    throw original;
  });
  const service = new AmapWebServiceRouteService(client);

  await assert.rejects(
    () => service.plan({
      origin: { latitude: 31.2304, longitude: 121.4737 },
      destination: { latitude: 31.2404, longitude: 121.4837 },
      mode: 'walk',
    }),
    (error: unknown) => error === original,
  );
});

test('converts Amap business failures and invalid route DTOs to safe provider errors', async () => {
  const responses: unknown[] = [
    { status: '0', info: 'SOME_UPSTREAM_MESSAGE' },
    {
      status: '1',
      route: {
        paths: [
          {
            distance: '1200',
            duration: '600',
            steps: [{ polyline: 'PRIVATE_INVALID_LOCATION' }],
          },
        ],
      },
    },
  ];

  for (const response of responses) {
    const client = new FakeAmapHttpClient(async () => response);
    const service = new AmapWebServiceRouteService(client);
    await assert.rejects(
      () => service.plan({
        origin: { latitude: 31.2304, longitude: 121.4737 },
        destination: { latitude: 31.2404, longitude: 121.4837 },
        mode: 'taxi',
      }),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'PROVIDER_ERROR');
        assert.equal(error.message, '路线服务暂时不可用，请稍后重试。');
        assert.equal(error.message.includes('SOME_UPSTREAM_MESSAGE'), false);
        assert.equal(error.message.includes('PRIVATE_INVALID_LOCATION'), false);
        return true;
      },
    );
  }
});
