import assert from 'node:assert/strict';
import test from 'node:test';
import { TRIP_GENERATION_BUDGET_MS } from '../server/services/trip-generation-orchestrator';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { referencedPlaceIdsInTripOrder } from '../src/repositories/trip-repository';
import {
  BffTripGenerationService,
  DEFAULT_TRIP_GENERATION_TIMEOUT_MS,
  parseTripGenerationPayload,
  toTripGenerationRequirement,
  TRIP_GENERATE_PATH,
} from '../src/services/bff-trip-generation-service';
import { BffClientError, type FetchLike } from '../src/services/bff-client';

const INVALID_REQUEST_MESSAGE = '请求无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const NETWORK_ERROR_MESSAGE = '网络异常，请稍后重试。';

const requirement = {
  destination: '上海',
  origin: '北京',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  durationDays: 3,
  travelerCount: 2,
  totalBudget: 5000,
  pace: 'relaxed' as const,
  preferences: { interests: ['咖啡', '建筑'] },
};

function placesForTrip(trip: typeof mockShanghaiTrip) {
  const byId = new Map(mockPlaces.map((place) => [place.id, structuredClone(place)]));
  return referencedPlaceIdsInTripOrder(trip).map((placeId) => {
    const place = byId.get(placeId);
    if (!place) {
      throw new Error(`missing mock place ${placeId}`);
    }
    return place;
  });
}

function successPayload() {
  return {
    data: {
      trip: structuredClone(mockShanghaiTrip),
      places: placesForTrip(mockShanghaiTrip),
      diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 1 },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('posts only the relative generate path with a requirement body', async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const payload = successPayload();
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse(payload);
  };
  const service = new BffTripGenerationService(fakeFetch);
  const result = await service.generate(requirement);
  result.trip.title = 'mutated';
  payload.data.diagnostics.unresolvedRoutesCount = 9;

  assert.equal(result.trip.destination, '上海');
  assert.equal(result.trip.title, 'mutated');
  assert.equal(result.places[0].id, mockShanghaiTrip.days[0].places[0].placeId);
  result.places[0].name = 'mutated-place';
  assert.equal(payload.data.places[0].name, mockPlaces.find((place) => place.id === payload.data.places[0].id)?.name);
  assert.deepEqual(result.diagnostics, { unresolvedPlacesCount: 0, unresolvedRoutesCount: 1 });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, TRIP_GENERATE_PATH);
  assert.equal(captured[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured[0].init?.body)), { requirement });
  const serialized = String(captured[0].init?.body);
  assert.equal(serialized.includes('DASHSCOPE'), false);
  assert.equal(serialized.includes('key'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('schema'), false);
  assert.equal(DEFAULT_TRIP_GENERATION_TIMEOUT_MS, 115_000);
  assert.ok(DEFAULT_TRIP_GENERATION_TIMEOUT_MS > TRIP_GENERATION_BUDGET_MS);
  assert.equal(TRIP_GENERATION_BUDGET_MS, 105_000);
});

test('rejects invalid payloads and maps 422 without falling back', async () => {
  const parsed = parseTripGenerationPayload(successPayload());
  parsed.trip.days[0].title = 'changed';
  assert.equal(mockShanghaiTrip.days[0].title, '梧桐街区与江畔夜景');

  assert.throws(
    () => parseTripGenerationPayload({ data: { trip: mockShanghaiTrip, diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 0 } } }),
    (error: unknown) => error instanceof BffClientError && error.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => parseTripGenerationPayload({
      data: {
        trip: mockShanghaiTrip,
        places: [
          ...placesForTrip(mockShanghaiTrip),
          {
            id: 'amap:unused',
            provider: 'amap',
            providerPlaceId: 'unused',
            name: '未引用',
            address: '北京',
            latitude: 39.9,
            longitude: 116.4,
            category: 'attraction',
          },
        ],
        diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 1 },
      },
    }),
    (error: unknown) => error instanceof BffClientError && error.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => parseTripGenerationPayload({
      data: {
        trip: mockShanghaiTrip,
        places: placesForTrip(mockShanghaiTrip).map((place, index) => (
          index === 0 ? { ...place, typecode: '110000' } : place
        )),
        diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 1 },
      },
    }),
    (error: unknown) => error instanceof BffClientError && error.code === 'INVALID_RESPONSE',
  );

  const service = new BffTripGenerationService(async () =>
    jsonResponse({
      error: {
        code: 'TRIP_GENERATION_INCOMPLETE',
        message: '暂时无法生成完整的旅行方案，请调整需求后重试。',
      },
    }, 422),
  );
  await assert.rejects(
    () => service.generate(requirement),
    (error: unknown) =>
      error instanceof BffClientError && error.code === 'TRIP_GENERATION_INCOMPLETE',
  );

  assert.equal(toTripGenerationRequirement({ destination: '上海' } as never), undefined);
  await assert.rejects(
    () => new BffTripGenerationService(async () => {
      throw new Error('should not fetch');
    }).generate({ destination: '上海', travelerCount: 2, totalBudget: 5000, pace: 'relaxed' }),
    (error: unknown) =>
      error instanceof BffClientError
      && error.code === 'INVALID_REQUEST'
      && error.message === INVALID_REQUEST_MESSAGE,
  );
});

test('maps timeout, network, 502 and 503 without leaking internals', async () => {
  const timeoutService = new BffTripGenerationService(async () =>
    jsonResponse({
      error: { code: 'TRIP_GENERATION_TIMEOUT', message: '行程生成时间较长，请稍后重试。' },
    }, 504),
  );
  await assert.rejects(
    () => timeoutService.generate(requirement),
    (error: unknown) =>
      error instanceof BffClientError && error.code === 'TRIP_GENERATION_TIMEOUT',
  );

  const abortTimeoutService = new BffTripGenerationService((_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted at dashscope.aliyuncs.com', 'AbortError'));
      });
    }), 5);
  await assert.rejects(
    () => abortTimeoutService.generate(requirement),
    (error: unknown) =>
      error instanceof BffClientError
      && error.code === 'NETWORK_ERROR'
      && error.message === NETWORK_ERROR_MESSAGE
      && !error.message.includes('dashscope'),
  );

  const networkService = new BffTripGenerationService(async () => {
    throw new Error('socket hang up https://restapi.amap.com');
  });
  await assert.rejects(
    () => networkService.generate(requirement),
    (error: unknown) =>
      error instanceof BffClientError
      && error.code === 'NETWORK_ERROR'
      && !String(error).includes('amap.com'),
  );

  const providerService = new BffTripGenerationService(async () =>
    jsonResponse({
      error: { code: 'PROVIDER_ERROR', message: '地点与路线服务暂时不可用，请稍后重试。' },
    }, 502),
  );
  await assert.rejects(
    () => providerService.generate(requirement),
    (error: unknown) => error instanceof BffClientError && error.code === 'PROVIDER_ERROR',
  );

  const unavailableService = new BffTripGenerationService(async () =>
    jsonResponse({
      error: { code: 'PROVIDER_UNAVAILABLE', message: '地点与路线服务尚未配置，请稍后再试。' },
    }, 503),
  );
  await assert.rejects(
    () => unavailableService.generate(requirement),
    (error: unknown) => error instanceof BffClientError && error.code === 'PROVIDER_UNAVAILABLE',
  );

  const invalidService = new BffTripGenerationService(async () =>
    new Response('<html>RAW</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(
    () => invalidService.generate(requirement),
    (error: unknown) =>
      error instanceof BffClientError
      && error.code === 'INVALID_RESPONSE'
      && error.message === INVALID_RESPONSE_MESSAGE,
  );
});
