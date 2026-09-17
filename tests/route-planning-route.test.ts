import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { AmapProviderError } from '../server/services/amap-http-client';
import type {
  AmapRouteService,
  RoutePlanningInput,
  RouteResult,
} from '../server/services/amap-route-service';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const internalRoute: RouteResult = {
  transport: {
    mode: 'walk',
    durationMinutes: 12,
    distanceMeters: 850,
  },
  polyline: [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.24, longitude: 121.49 },
  ],
};

class FakeRouteService implements AmapRouteService {
  calls: RoutePlanningInput[] = [];

  constructor(
    private readonly handler: (
      input: RoutePlanningInput,
    ) => Promise<RouteResult> = async () => internalRoute,
  ) {}

  async plan(input: RoutePlanningInput): Promise<RouteResult> {
    this.calls.push(structuredClone(input));
    return this.handler(input);
  }
}

async function request(
  path: string,
  options: {
    method?: string;
    routeService?: AmapRouteService;
  } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(
    createApp(config, { routeService: options.routeService }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      { method: options.method ?? 'GET' },
    );
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

function validQuery(mode: 'walk' | 'taxi' = 'walk'): string {
  return `/api/routes?originLng=121.47&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=${mode}`;
}

function assertNoSensitiveData(text: string): void {
  for (const secret of [
    'test-amap-web-service-key',
    'restapi.amap.com',
    'SOME_UPSTREAM_INFO',
    'RAW_AMAP_DTO',
    'stack',
    'jscode',
  ]) {
    assert.equal(text.includes(secret), false);
  }
}

test('plans a walking route with correctly ordered internal coordinates', async () => {
  const service = new FakeRouteService();
  const result = await request(validQuery(), { routeService: service });

  assert.equal(result.status, 200);
  assert.deepEqual(service.calls, [
    {
      origin: { longitude: 121.47, latitude: 31.23 },
      destination: { longitude: 121.49, latitude: 31.24 },
      mode: 'walk',
    },
  ]);
  assert.deepEqual(result.body, { data: { route: internalRoute } });
  assertNoSensitiveData(result.text);
});

test('plans a taxi route', async () => {
  const taxiRoute: RouteResult = {
    ...internalRoute,
    transport: { ...internalRoute.transport, mode: 'taxi' },
  };
  const service = new FakeRouteService(async () => taxiRoute);
  const result = await request(validQuery('taxi'), { routeService: service });

  assert.equal(result.status, 200);
  assert.equal(service.calls[0].mode, 'taxi');
  assert.deepEqual(result.body, { data: { route: taxiRoute } });
});

test('rejects missing, malformed, out-of-range, and unsupported parameters', async () => {
  const service = new FakeRouteService();
  const invalidPaths = [
    '/api/routes?originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLng=121.49&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLng=121.49&destinationLat=31.24',
    '/api/routes?originLng=&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=NaN&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=Infinity&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=181&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&originLat=-91&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLng=-181&destinationLat=31.24&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLng=121.49&destinationLat=91&mode=walk',
    '/api/routes?originLng=121.47&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=metro',
  ];

  for (const path of invalidPaths) {
    const result = await request(path, { routeService: service });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: {
        code: 'INVALID_REQUEST',
        message: '路线参数无效，请调整后重试。',
      },
    });
    assertNoSensitiveData(result.text);
  }
  assert.equal(service.calls.length, 0);
});

test('rejects repeated, array, and object parameters', async () => {
  const service = new FakeRouteService();
  const invalidPaths = [
    `${validQuery()}&originLng=121.48`,
    '/api/routes?originLng[]=121.47&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
    '/api/routes?originLng[value]=121.47&originLat=31.23&destinationLng=121.49&destinationLat=31.24&mode=walk',
  ];

  for (const path of invalidPaths) {
    const result = await request(path, { routeService: service });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      error: {
        code: 'INVALID_REQUEST',
        message: '路线参数无效，请调整后重试。',
      },
    });
  }
  assert.equal(service.calls.length, 0);
});

test('rejects protected Amap parameters without forwarding or echoing them', async () => {
  const service = new FakeRouteService();
  for (const protectedParam of ['key', 'jscode', 'sig', 'callback']) {
    const result = await request(
      `${validQuery()}&${protectedParam}=PRIVATE_VALUE`,
      { routeService: service },
    );
    assert.equal(result.status, 400);
    assert.equal(result.text.includes('PRIVATE_VALUE'), false);
    assert.equal(result.text.includes(protectedParam), false);
  }
  assert.equal(service.calls.length, 0);
});

test('returns 503 when no route service is injected', async () => {
  const result = await request(validQuery());

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: '路线服务尚未配置。',
    },
  });
  assertNoSensitiveData(result.text);
});

test('maps AmapProviderError codes to stable HTTP responses', async () => {
  const cases: Array<{
    code: AmapProviderError['code'];
    status: number;
    message: string;
  }> = [
    {
      code: 'INVALID_REQUEST',
      status: 400,
      message: '路线参数无效，请调整后重试。',
    },
    {
      code: 'PROVIDER_ERROR',
      status: 502,
      message: '路线服务暂时不可用，请稍后重试。',
    },
    {
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
      message: '路线服务尚未配置。',
    },
  ];

  for (const expected of cases) {
    const service = new FakeRouteService(async () => {
      throw new AmapProviderError(
        expected.code,
        'SOME_UPSTREAM_INFO RAW_AMAP_DTO restapi.amap.com',
      );
    });
    const result = await request(validQuery(), { routeService: service });
    assert.equal(result.status, expected.status);
    assert.deepEqual(result.body, {
      error: { code: expected.code, message: expected.message },
    });
    assertNoSensitiveData(result.text);
  }
});

test('returns a JSON 405 for non-GET requests', async () => {
  const service = new FakeRouteService();
  const result = await request(validQuery(), {
    method: 'POST',
    routeService: service,
  });

  assert.equal(result.status, 405);
  assert.deepEqual(result.body, {
    error: { code: 'INVALID_REQUEST', message: '仅支持查询路线。' },
  });
  assert.equal(service.calls.length, 0);
});
