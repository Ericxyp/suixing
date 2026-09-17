import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { MockTripRepository } from '../src/repositories/mock-trip-repository';
import { referencedPlaceIdsInTripOrder } from '../src/repositories/trip-repository';
import { BffClientError } from '../src/services/bff-client';
import { BffTripGenerationService } from '../src/services/bff-trip-generation-service';
import {
  createTripGenerationService,
  getTripGenerationMode,
  noticeForTripGenerationError,
  TRIP_GENERATION_AI_UNAVAILABLE_NOTICE,
  TRIP_GENERATION_GENERIC_NOTICE,
  TRIP_GENERATION_INCOMPLETE_NOTICE,
  TRIP_GENERATION_INVALID_RESPONSE_NOTICE,
  TRIP_GENERATION_PROVIDER_ERROR_NOTICE,
  TRIP_GENERATION_PROVIDER_UNAVAILABLE_NOTICE,
  TRIP_GENERATION_TIMEOUT_NOTICE,
} from '../src/services/trip-generation-service';

const requirement = {
  destination: '杭州',
  durationDays: 2,
  travelerCount: 2,
  totalBudget: 3000,
  pace: 'balanced' as const,
  preferences: { interests: ['西湖'] },
};

test('parses trip generation mode and defaults unknown values to mock', () => {
  assert.equal(getTripGenerationMode('mock'), 'mock');
  assert.equal(getTripGenerationMode('bff'), 'bff');
  assert.equal(getTripGenerationMode(' bff '), 'bff');
  assert.equal(getTripGenerationMode(undefined), 'mock');
  assert.equal(getTripGenerationMode(''), 'mock');
  assert.equal(getTripGenerationMode('   '), 'mock');
  assert.equal(getTripGenerationMode('BFF'), 'mock');
  assert.equal(getTripGenerationMode('qwen'), 'mock');
});

test('factory keeps mock local and bff on the generate endpoint', async () => {
  const repository = new MockTripRepository();
  let fetches = 0;
  const mockService = createTripGenerationService(getTripGenerationMode(undefined), {
    userId: 'user-demo-001',
    repository,
    fetch: async () => {
      fetches += 1;
      throw new Error('mock must not call BFF');
    },
  });
  const created = await mockService.generate(requirement);
  assert.equal(created.trip.destination, '杭州');
  assert.deepEqual(created.places, []);
  assert.equal(await repository.getTripById(created.trip.id) !== null, true);
  assert.equal(fetches, 0);

  const bffService = createTripGenerationService('bff', {
    userId: 'user-demo-001',
    repository: new MockTripRepository(),
    fetch: async (input, init) => {
      fetches += 1;
      assert.equal(String(input), '/api/trips/generate');
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify({
        data: {
          trip: structuredClone(mockShanghaiTrip),
          places: referencedPlaceIdsInTripOrder(mockShanghaiTrip).map((placeId) => (
            structuredClone(mockPlaces.find((place) => place.id === placeId)!)
          )),
          diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 0 },
        },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(bffService instanceof BffTripGenerationService, true);
  const generated = await bffService.generate({
    destination: '上海',
    durationDays: 3,
    travelerCount: 2,
    totalBudget: 5000,
    pace: 'relaxed',
  });
  assert.equal(generated.trip.id, mockShanghaiTrip.id);
  assert.equal(fetches, 1);
});

test('maps generation errors by code rather than message text', () => {
  assert.equal(
    noticeForTripGenerationError(new BffClientError('TRIP_GENERATION_INCOMPLETE', 'ignore this')),
    TRIP_GENERATION_INCOMPLETE_NOTICE,
  );
  assert.equal(TRIP_GENERATION_INCOMPLETE_NOTICE.includes('调整目的地'), false);
  assert.equal(
    noticeForTripGenerationError(new BffClientError('TRIP_GENERATION_TIMEOUT', 'ignore this')),
    TRIP_GENERATION_TIMEOUT_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('INVALID_RESPONSE', 'ignore this')),
    TRIP_GENERATION_INVALID_RESPONSE_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('AI_INVALID_RESPONSE', 'ignore this')),
    TRIP_GENERATION_INVALID_RESPONSE_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('PROVIDER_ERROR', 'ignore this')),
    TRIP_GENERATION_PROVIDER_ERROR_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('PROVIDER_UNAVAILABLE', 'ignore this')),
    TRIP_GENERATION_PROVIDER_UNAVAILABLE_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('AI_PROVIDER_UNAVAILABLE', 'ignore this')),
    TRIP_GENERATION_AI_UNAVAILABLE_NOTICE,
  );
  assert.equal(
    noticeForTripGenerationError(new BffClientError('NETWORK_ERROR', 'ignore this')),
    TRIP_GENERATION_GENERIC_NOTICE,
  );
  assert.equal(noticeForTripGenerationError(new Error('RAW stack')), TRIP_GENERATION_GENERIC_NOTICE);
});

test('plan conversation page composes generation without importing BFF internals', () => {
  const page = readFileSync(join(process.cwd(), 'src/pages/PlanConversationPage.tsx'), 'utf8');
  assert.match(page, /createTripGenerationService/);
  assert.match(page, /VITE_TRIP_GENERATION_MODE/);
  assert.match(page, /VITE_TRIP_AI_MODE/);
  assert.equal(page.includes('BffTripGenerationService'), false);
  assert.equal(page.includes('MockTripGenerationService'), false);
  assert.equal(page.includes('DASHSCOPE'), false);
  assert.equal(page.includes('QWEN_MODEL'), false);
  assert.equal(page.includes('AMAP_WEB_SERVICE_KEY'), false);
});
