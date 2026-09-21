import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmedTripBuilder, type BuildTripInput, type TripBuilder, type TripBuildResult } from '../server/services/trip-builder';
import {
  ServerTripGenerationOrchestrator,
  TRIP_GENERATION_INCOMPLETE_MESSAGE,
  TripGenerationIncompleteError,
} from '../server/services/trip-generation-orchestrator';
import type { GenerationStageLog } from '../server/services/generation-logger';
import type { ConfirmedTripRequirement, TripPlanGenerator, TripPlanSuggestion } from '../server/services/trip-plan-generator';
import type {
  ResolvedTripPlanSuggestion,
  TripPlaceResolver,
} from '../server/services/trip-place-resolver';
import type { RouteEnrichedTripPlanSuggestion, TripRouteEnricher } from '../server/services/trip-route-enricher';
import { validateDayItineraryCompleteness } from '../server/services/trip-itinerary-completeness-validator';
import { isCoreTripPlace, parseClockMinutes, planDaySchedule } from '../server/services/trip-day-density-planner';
import { buildPlanningPolicyV1 } from '../src/services/travel-profile-policy';
import type { Place, Trip, TripPlace } from '../src/domain/trip/types';

const beijingParentsRequirement: ConfirmedTripRequirement = {
  destination: '北京',
  origin: '上海',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  durationDays: 3,
  travelerCount: 3,
  totalBudget: 2000,
  pace: 'balanced',
  preferences: { interests: ['咖啡', '拍照', '历史文化'] },
  tripIntent: { interestKeys: ['history', 'culture_art', 'coffee', 'photography'] },
  partyContext: {
    partyType: 'parents',
    hasElderly: true,
    mobilityRequirement: 'low_walking',
  },
  constraints: { excludedInterestKeys: [], lowWalking: true },
};

function mappedPlace(id: string, name: string, latitude: number, longitude: number): Place {
  return {
    id,
    provider: 'amap',
    providerPlaceId: id.replace('amap:', ''),
    name,
    address: '北京市东城区示例路 1 号',
    latitude,
    longitude,
    category: 'attraction',
  };
}

const dayStops: Array<Array<{ place: Place; duration: number }>> = [
  [
    { place: mappedPlace('amap:D1A', '故宫博物院', 39.916, 116.397), duration: 90 },
    { place: mappedPlace('amap:D1B', '景山公园', 39.923, 116.396), duration: 75 },
  ],
  [
    { place: mappedPlace('amap:D2A', '天坛公园', 39.882, 116.406), duration: 90 },
    { place: mappedPlace('amap:D2B', '天安门广场', 39.904, 116.397), duration: 75 },
  ],
  [
    { place: mappedPlace('amap:D3A', '颐和园', 39.999, 116.275), duration: 90 },
    { place: mappedPlace('amap:D3B', '圆明园', 40.008, 116.298), duration: 75 },
  ],
];

function suggestion(): TripPlanSuggestion {
  return {
    title: '北京 3 日历史文化',
    summary: '带父母、少走路的北京三日安排。',
    days: dayStops.map((stops, index) => ({
      dayNumber: index + 1,
      title: `第${index + 1}日`,
      summary: '集中安排两处核心地点。',
      placeQueries: stops.map((item) => ({
        name: item.place.name,
        query: item.place.name,
        category: 'sight' as const,
        suggestedStartTime: '10:00',
        suggestedDurationMinutes: item.duration,
        reason: '历史文化且步行较少。',
      })),
    })),
  };
}

function resolved(): ResolvedTripPlanSuggestion {
  return {
    title: suggestion().title,
    summary: suggestion().summary,
    unresolved: [],
    days: dayStops.map((stops, index) => ({
      dayNumber: index + 1,
      title: `第${index + 1}日`,
      summary: '集中安排两处核心地点。',
      stops: stops.map((item) => ({
        place: item.place,
        category: 'sight' as const,
        suggestedStartTime: '10:00',
        suggestedDurationMinutes: item.duration,
        reason: '历史文化且步行较少。',
        sourceQuery: item.place.name,
      })),
    })),
  };
}

function enriched(plan: ResolvedTripPlanSuggestion): RouteEnrichedTripPlanSuggestion {
  return {
    title: plan.title,
    summary: plan.summary,
    unresolved: plan.unresolved,
    days: plan.days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      summary: day.summary,
      stops: day.stops,
      routes: [{
        fromPlaceId: day.stops[0].place.id,
        toPlaceId: day.stops[1].place.id,
        transport: { mode: 'taxi' as const, distanceMeters: 3500, durationMinutes: 20 },
        polyline: [
          { latitude: day.stops[0].place.latitude, longitude: day.stops[0].place.longitude },
          { latitude: day.stops[1].place.latitude, longitude: day.stops[1].place.longitude },
        ],
      }],
      unresolvedRoutes: [],
    })),
  };
}

class RecordingBuilder implements TripBuilder {
  lastInput: BuildTripInput | undefined;
  private readonly inner = new ConfirmedTripBuilder();

  build(input: BuildTripInput): TripBuildResult {
    this.lastInput = structuredClone(input);
    return this.inner.build(input);
  }
}

function dayLastEnd(items: NonNullable<Trip['days'][number]['scheduleItems']>): number {
  return items.reduce((max, item) => (
    Math.max(max, (parseClockMinutes(item.startTime) ?? 0) + item.durationMinutes)
  ), 0);
}

function dayMaxGap(items: NonNullable<Trip['days'][number]['scheduleItems']>): number {
  const sorted = [...items].sort((left, right) => (
    (parseClockMinutes(left.startTime) ?? 0) - (parseClockMinutes(right.startTime) ?? 0)
  ));
  let max = 0;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const end = (parseClockMinutes(sorted[index].startTime) ?? 0) + sorted[index].durationMinutes;
    const next = parseClockMinutes(sorted[index + 1].startTime) ?? 0;
    max = Math.max(max, next - end);
  }
  return max;
}

test('Beijing parents low-walking pipeline schedules two cores through builder and validator', async () => {
  const policy = buildPlanningPolicyV1({
    tripIntent: beijingParentsRequirement.tripIntent,
    partyContext: beijingParentsRequirement.partyContext,
    constraints: beijingParentsRequirement.constraints,
    tripPace: beijingParentsRequirement.pace,
  });
  assert.equal(policy.targetCorePlacesPerDay, 2);

  const builder = new RecordingBuilder();
  const logs: GenerationStageLog[] = [];
  const subject = new ServerTripGenerationOrchestrator({
    planGenerator: {
      async generate() {
        return suggestion();
      },
    } as TripPlanGenerator,
    placeResolver: {
      async resolve() {
        return resolved();
      },
    } as TripPlaceResolver,
    routeEnricher: {
      async enrich(input) {
        return enriched(input.plan);
      },
    } as TripRouteEnricher,
    tripBuilder: builder,
    userId: 'user-demo-001',
    logger: { logStage: (entry) => logs.push(entry) },
  });

  const result = await subject.generate({
    requirement: beijingParentsRequirement,
    tripId: 'trip-beijing-parents',
    createdAt: '2026-09-16T00:00:00.000Z',
    requestId: 'gpipeline00001',
  });

  assert.equal(builder.lastInput?.planningPolicy?.targetCorePlacesPerDay, 2);
  assert.equal(suggestion().days.every((day) => (
    day.placeQueries.every((item) => item.category === 'sight' || item.category === 'activity')
  )), true);
  assert.equal(result.trip.days.length, 3);
  for (const day of result.trip.days) {
    const cores = day.places.filter((place) => isCoreTripPlace(place));
    assert.equal(cores.length, 2);
    const items = day.scheduleItems ?? [];
    assert.equal(items.some((item) => (
      (item.kind === 'meal' || item.kind === 'meal_place' || item.kind === 'meal_slot')
      && item.mealPeriod === 'lunch'
    )), true);
    assert.ok(dayLastEnd(items) >= 16 * 60 + 30, `day ${day.dayNumber} ended too early`);
    assert.ok(dayMaxGap(items) <= 90, `day ${day.dayNumber} has a large gap`);
    const completeness = validateDayItineraryCompleteness({
      pace: result.trip.pace,
      targetCorePlacesPerDay: policy.targetCorePlacesPerDay,
      placeIds: new Set(day.places.map((place) => place.id)),
      corePlaceCount: cores.length,
      items,
      places: day.places,
    });
    assert.equal(completeness.valid, true, completeness.reason);
  }
  assert.equal(logs.some((entry) => entry.validationReason), false);
});

test('default balanced two-core days still fail completeness after this change', () => {
  const places: TripPlace[] = [
    {
      id: 'a',
      dayId: 'day-1',
      order: 1,
      placeId: 'a',
      placeName: '天坛公园',
      type: 'attraction',
      estimatedCost: 0,
      startTime: '10:00',
      durationMinutes: 75,
      transportToNext: { mode: 'taxi', durationMinutes: 20, distanceMeters: 4000 },
    },
    {
      id: 'b',
      dayId: 'day-1',
      order: 2,
      placeId: 'b',
      placeName: '颐和园',
      type: 'attraction',
      estimatedCost: 0,
      startTime: '14:30',
      durationMinutes: 75,
    },
  ];
  const planned = planDaySchedule({
    dayId: 'day-1',
    destination: '北京',
    pace: 'balanced',
    places,
  });
  const completeness = validateDayItineraryCompleteness({
    pace: 'balanced',
    placeIds: new Set(places.map((place) => place.id)),
    corePlaceCount: 2,
    items: planned.items,
    places: planned.places,
  });
  assert.equal(completeness.valid, false);
  assert.ok(
    completeness.reason === 'INVALID_TWO_PLACE_DAY' || completeness.reason === 'DAY_ENDS_TOO_EARLY',
    completeness.reason,
  );
});

test('generation incomplete error keeps validationReason for logs but not the user message', () => {
  const error = new TripGenerationIncompleteError({ validationReason: 'DAY_ENDS_TOO_EARLY' });
  assert.equal(error.validationReason, 'DAY_ENDS_TOO_EARLY');
  assert.equal(error.message, TRIP_GENERATION_INCOMPLETE_MESSAGE);
  assert.equal(error.message.includes('DAY_ENDS_TOO_EARLY'), false);
});

test('builder plus validator logs the real completeness reason when the day cannot be filled', async () => {
  const logs: GenerationStageLog[] = [];
  const earlyTrip: Trip = {
    id: 'trip-beijing-short',
    userId: 'user-demo-001',
    title: '北京 3 日',
    destination: '北京',
    travelerCount: 3,
    totalBudget: 2000,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: [] },
    status: 'PLANNING',
    days: [{
      id: 'trip-beijing-short:day:1',
      tripId: 'trip-beijing-short',
      dayNumber: 1,
      date: '2026-10-01',
      places: [
        {
          id: 'p1',
          dayId: 'trip-beijing-short:day:1',
          order: 1,
          placeId: 'amap:D1A',
          placeName: '故宫博物院',
          type: 'attraction',
          estimatedCost: 0,
          startTime: '10:00',
          durationMinutes: 60,
        },
        {
          id: 'p2',
          dayId: 'trip-beijing-short:day:1',
          order: 2,
          placeId: 'amap:D1B',
          placeName: '景山公园',
          type: 'attraction',
          estimatedCost: 0,
          startTime: '12:00',
          durationMinutes: 60,
        },
      ],
      scheduleItems: [
        { kind: 'place', tripPlaceId: 'p1', startTime: '10:00', durationMinutes: 60 },
        {
          kind: 'meal_slot',
          id: 'lunch',
          mealPeriod: 'lunch',
          startTime: '11:15',
          durationMinutes: 75,
          areaTripPlaceId: 'p1',
          nextTripPlaceId: 'p2',
          diningMode: 'flexible',
        },
        { kind: 'place', tripPlaceId: 'p2', startTime: '12:45', durationMinutes: 60 },
      ],
    }],
    routes: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
  const subject = new ServerTripGenerationOrchestrator({
    planGenerator: {
      async generate() {
        return suggestion();
      },
    } as TripPlanGenerator,
    placeResolver: {
      async resolve() {
        return resolved();
      },
    } as TripPlaceResolver,
    routeEnricher: {
      async enrich(input) {
        return enriched(input.plan);
      },
    } as TripRouteEnricher,
    tripBuilder: {
      build() {
        return {
          trip: structuredClone(earlyTrip),
          places: [],
          diagnostics: { unresolvedPlacesCount: 0, unresolvedRoutesCount: 0 },
        };
      },
    },
    userId: 'user-demo-001',
    logger: { logStage: (entry) => logs.push(entry) },
  });

  await assert.rejects(
    () => subject.generate({
      requirement: beijingParentsRequirement,
      tripId: 'trip-beijing-short',
      createdAt: '2026-09-16T00:00:00.000Z',
      requestId: 'gshortfail0001',
    }),
    (error: unknown) => {
      assert.ok(error instanceof TripGenerationIncompleteError);
      assert.equal(error.validationReason, 'DAY_ENDS_TOO_EARLY');
      assert.equal(error.message, TRIP_GENERATION_INCOMPLETE_MESSAGE);
      return true;
    },
  );
  const failed = logs.find((entry) => entry.stage === 'trip_build' && entry.outcome === 'failed');
  assert.equal(failed?.errorCode, 'TRIP_GENERATION_INCOMPLETE');
  assert.equal(failed?.validationReason, 'DAY_ENDS_TOO_EARLY');
  assert.equal(JSON.stringify(logs).includes('故宫'), false);
});
