import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import type { GenerationStageLog, GenerationStageLogger } from '../server/services/generation-logger';
import {
  TripChangeExecutionError,
  type ExecuteReplacePlaceResult,
  type ExecuteSelectMealPlaceInput,
  type ExecuteSelectMealPlaceResult,
  type TripChangeClock,
  type TripChangeExecutor,
} from '../server/services/trip-change-executor';
import type { Place, Trip } from '../src/domain/trip/types';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const FIXED_NOW = '2026-09-16T12:00:00.000Z';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '杭州市西湖区示例路 1 号',
    latitude: 30.24,
    longitude: 120.15,
    category: 'attraction',
    ...overrides,
  };
}

const temple = place({ id: 'amap:LINGYIN', name: '灵隐寺', latitude: 30.24, longitude: 120.1 });
const peak = place({ id: 'amap:FEILAI', name: '飞来峰造像', latitude: 30.241, longitude: 120.101 });
const restaurant = place({
  id: 'amap:MEAL-R1',
  name: '灵隐寺附近面馆',
  category: 'restaurant',
  latitude: 30.242,
  longitude: 120.102,
});

function sampleTrip(): Trip {
  return {
    id: 'trip-hz',
    userId: 'user-1',
    title: '杭州 2 日游',
    destination: '杭州',
    travelerCount: 2,
    totalBudget: 3000,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: ['自然风光'] },
    status: 'PLANNING',
    days: [
      {
        id: 'day-1',
        tripId: 'trip-hz',
        dayNumber: 1,
        date: '2026-09-20',
        title: '西湖',
        summary: '西湖一日。',
        places: [
          {
            id: 'day-1:stop:1',
            dayId: 'day-1',
            order: 1,
            placeId: temple.id,
            placeName: temple.name,
            type: temple.category,
            startTime: '10:00',
            durationMinutes: 120,
            description: '灵隐寺停留。',
            estimatedCost: 0,
          },
          {
            id: 'day-1:stop:2',
            dayId: 'day-1',
            order: 2,
            placeId: peak.id,
            placeName: peak.name,
            type: peak.category,
            startTime: '14:00',
            durationMinutes: 90,
            description: '飞来峰造像停留。',
            estimatedCost: 0,
          },
        ],
        scheduleItems: [
          { kind: 'place', tripPlaceId: 'day-1:stop:1', startTime: '10:00', durationMinutes: 120 },
          {
            kind: 'meal_slot',
            id: 'day-1:meal:lunch',
            mealPeriod: 'lunch',
            startTime: '12:15',
            durationMinutes: 75,
            areaTripPlaceId: 'day-1:stop:1',
            nextTripPlaceId: 'day-1:stop:2',
            diningMode: 'flexible',
          },
          { kind: 'place', tripPlaceId: 'day-1:stop:2', startTime: '14:00', durationMinutes: 90 },
        ],
      },
    ],
    routes: [],
    createdAt: '2026-09-16T01:00:00.000Z',
    updatedAt: '2026-09-16T02:00:00.000Z',
  };
}

class FakeExecutor implements TripChangeExecutor {
  mealCalls: ExecuteSelectMealPlaceInput[] = [];

  constructor(
    private readonly handler: (
      input: ExecuteSelectMealPlaceInput,
    ) => Promise<ExecuteSelectMealPlaceResult> = async (input) => ({
      trip: input.trip,
      places: input.places,
      summary: {
        type: 'SELECT_MEAL_PLACE',
        dayNumber: 1,
        mealSlotId: 'day-1:meal:lunch',
        nextPlaceName: restaurant.name,
        routeRecalculated: true,
      },
    }),
  ) {}

  async replacePlace(): Promise<ExecuteReplacePlaceResult> {
    throw new Error('not used');
  }

  async selectMealPlace(input: ExecuteSelectMealPlaceInput): Promise<ExecuteSelectMealPlaceResult> {
    this.mealCalls.push(structuredClone(input));
    return this.handler(input);
  }
}

class FakeClock implements TripChangeClock {
  nowIso(): string {
    return FIXED_NOW;
  }
}

class FakeLogger implements GenerationStageLogger {
  entries: GenerationStageLog[] = [];

  logStage(entry: GenerationStageLog): void {
    this.entries.push({ ...entry });
  }
}

function validPayload(): Record<string, unknown> {
  return {
    trip: sampleTrip(),
    places: [temple, peak],
    operation: {
      type: 'SELECT_MEAL_PLACE',
      dayNumber: 1,
      mealSlotId: 'day-1:meal:lunch',
      placeId: restaurant.id,
    },
  };
}

async function request(options: {
  body?: string;
  executor?: TripChangeExecutor;
  logger?: GenerationStageLogger;
}): Promise<{ status: number; body: unknown; text: string }> {
  const server = createServer(createApp(config, {
    tripChangeExecutor: options.executor,
    tripChangeClock: new FakeClock(),
    generationLogger: options.logger,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/trips/meal/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: options.body ?? JSON.stringify(validPayload()),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { status: response.status, body, text };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('meal_apply failed logs keep validationReason off the public response', async () => {
  const logger = new FakeLogger();
  const executor = new FakeExecutor(async () => {
    throw new TripChangeExecutionError(
      'TRIP_CHANGE_INCOMPLETE',
      'raw meal miss 灵隐寺 https://restapi.amap.com',
      'MEAL_CANDIDATE_UNAVAILABLE',
    );
  });
  const result = await request({ executor, logger });
  assert.equal(result.status, 422);
  assert.deepEqual(result.body, {
    error: {
      code: 'TRIP_CHANGE_INCOMPLETE',
      message: '暂时找不到合适的餐饮地点，请稍后再试。',
    },
  });
  assert.equal(result.text.includes('validationReason'), false);
  assert.equal(result.text.includes('MEAL_CANDIDATE_UNAVAILABLE'), false);
  assert.equal(result.text.includes('灵隐寺'), false);
  assert.equal(result.text.includes('restapi'), false);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].stage, 'meal_apply');
  assert.equal(logger.entries[0].outcome, 'failed');
  assert.equal(logger.entries[0].errorCode, 'TRIP_CHANGE_INCOMPLETE');
  assert.equal(logger.entries[0].validationReason, 'MEAL_CANDIDATE_UNAVAILABLE');
});

test('meal_apply unknown errors omit validationReason in logs', async () => {
  const logger = new FakeLogger();
  const executor = new FakeExecutor(async () => {
    throw new Error('boom stack at restapi.amap.com');
  });
  const result = await request({ executor, logger });
  assert.equal(result.status, 500);
  assert.equal(result.text.includes('validationReason'), false);
  assert.equal(result.text.includes('restapi'), false);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].stage, 'meal_apply');
  assert.equal(logger.entries[0].outcome, 'failed');
  assert.equal('validationReason' in logger.entries[0], false);
});
