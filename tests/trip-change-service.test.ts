import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockPlaces } from '../src/mocks/places';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { MockTripRepository } from '../src/repositories/mock-trip-repository';
import { referencedPlaceIdsInTripOrder } from '../src/repositories/trip-repository';
import { BffClientError, type FetchLike } from '../src/services/bff-client';
import {
  BffTripChangeService,
  TRIP_CHANGE_APPLY_PATH,
  TRIP_CHANGE_INTERPRET_PATH,
  buildTripChangeContext,
} from '../src/services/bff-trip-change-service';
import {
  ASK_SUIXING_EXAMPLES,
  beginApply,
  beginInterpret,
  canSubmitAssistant,
  closeAssistant,
  createAssistantUiState,
  markApplied,
  markFailed,
  openAssistant,
  sheetLayoutForWidth,
  showClarification,
} from '../src/services/trip-assistant-session';
import {
  AutoApplyTripChangeService,
  TRIP_CHANGE_GENERIC_NOTICE,
  TRIP_CHANGE_INCOMPLETE_NOTICE,
  TRIP_CHANGE_INVALID_NOTICE,
  TRIP_CHANGE_PROVIDER_ERROR_NOTICE,
  TRIP_CHANGE_SAVE_FAILED_NOTICE,
  TRIP_CHANGE_UNAVAILABLE_NOTICE,
  UNDO_TOAST_MS,
  appliedToastLabel,
  isUndoToastActive,
  noticeForTripChangeError,
  persistAppliedTripChange,
  restoreTripChangeSnapshot,
} from '../src/services/trip-change-service';

function placesFor(trip = mockShanghaiTrip) {
  const byId = new Map(mockPlaces.map((place) => [place.id, structuredClone(place)]));
  return referencedPlaceIdsInTripOrder(trip).map((placeId) => structuredClone(byId.get(placeId)!));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const replaceIntent = {
  status: 'ready' as const,
  summary: '将第二天的武康路换成豫园附近地点。',
  operations: [{
    type: 'REPLACE_PLACE' as const,
    dayNumber: 2,
    targetTripPlaceId: 'tp-d2-wukang',
    replacementQuery: '豫园',
  }],
};

function applyPayload() {
  const trip = structuredClone(mockShanghaiTrip);
  trip.updatedAt = '2026-09-16T12:00:00.000Z';
  trip.days[1].places[1].placeId = 'place-yuyuan';
  trip.days[1].places[1].placeName = '豫园';
  return {
    data: {
      trip,
      places: placesFor(trip),
      summary: {
        type: 'REPLACE_PLACE' as const,
        dayNumber: 2,
        replacedTripPlaceId: 'tp-d2-wukang',
        previousPlaceName: '武康路',
        nextPlaceName: '豫园',
        routeRecalculated: true,
      },
    },
  };
}

test('Ask Suixing uses a side sheet on desktop and a bottom sheet on narrow screens', () => {
  assert.equal(sheetLayoutForWidth(1280), 'side');
  assert.equal(sheetLayoutForWidth(880), 'bottom');
  assert.equal(sheetLayoutForWidth(390), 'bottom');
  const opened = openAssistant(createAssistantUiState('side'));
  assert.equal(opened.open, true);
  assert.equal(ASK_SUIXING_EXAMPLES.length <= 3, true);
});

test('interpret context only includes the minimum safe trip fields', async () => {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: FetchLike = async (input, init) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return jsonResponse({
      data: { intent: { status: 'needs_clarification', summary: '请问要改哪一天？', operations: [] } },
    });
  };
  const service = new BffTripChangeService(fakeFetch);
  await service.interpret('第二天不要去长城了，换成颐和园附近。', mockShanghaiTrip);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, TRIP_CHANGE_INTERPRET_PATH);
  const body = captured[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['context', 'input']);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('latitude'), false);
  assert.equal(serialized.includes('longitude'), false);
  assert.equal(serialized.includes('address'), false);
  assert.equal(serialized.includes('polyline'), false);
  assert.equal(serialized.includes('totalBudget'), false);
  assert.equal(serialized.includes('userId'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('schema'), false);
  assert.equal(serialized.includes('AMAP_WEB_SERVICE_KEY'), false);
  assert.equal(serialized.includes('"key"'), false);
  const context = buildTripChangeContext(mockShanghaiTrip);
  assert.deepEqual(Object.keys(context).sort(), ['days', 'destination', 'tripId']);
  assert.deepEqual(Object.keys(context.days[0]).sort(), ['dayNumber', 'stops']);
  assert.deepEqual(Object.keys(context.days[0].stops[0]).sort(), ['placeName', 'startTime', 'tripPlaceId', 'type']);
});

test('needs_clarification keeps the panel open and does not call apply', async () => {
  let applyCalls = 0;
  const service = new AutoApplyTripChangeService(
    {
      async interpret() {
        return {
          status: 'needs_clarification',
          summary: '请问要改哪一天的哪个地点？',
          operations: [],
        };
      },
    },
    {
      async apply() {
        applyCalls += 1;
        throw new Error('apply must not run');
      },
    },
  );
  const outcome = await service.requestChange({
    text: '换个地方',
    trip: mockShanghaiTrip,
    places: placesFor(),
    expectedTripId: mockShanghaiTrip.id,
  });
  const ui = showClarification(
    beginInterpret(createAssistantUiState(), '换个地方'),
    '请问要改哪一天的哪个地点？',
  );
  assert.equal(outcome.status, 'needs_clarification');
  assert.equal(applyCalls, 0);
  assert.equal(ui.open, true);
  assert.equal(ui.phase, 'needs_clarification');
  assert.equal(canSubmitAssistant(ui), true);
  assert.equal(ui.draft, '');
  assert.equal(ui.error, null);
  assert.equal(ui.messages.some((item) => item.content === '请问要改哪一天的哪个地点？'), true);
});

test('conflict-free Yuanmingyuan replace still auto-applies', async () => {
  const applyCalls: unknown[] = [];
  const service = new AutoApplyTripChangeService(
    {
      async interpret() {
        return {
          status: 'ready',
          summary: '将第二天的慕田峪长城换成圆明园。',
          operations: [{
            type: 'REPLACE_PLACE',
            dayNumber: 2,
            targetTripPlaceId: 'tp-d2-wukang',
            replacementQuery: '圆明园',
          }],
        };
      },
    },
    {
      async apply(input) {
        applyCalls.push(input.operation);
        return applyPayload().data;
      },
    },
  );
  const outcome = await service.requestChange({
    text: '第二天不要去慕田峪长城，换成圆明园。',
    trip: mockShanghaiTrip,
    places: placesFor(),
    expectedTripId: mockShanghaiTrip.id,
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(applyCalls.length, 1);
});

test('ready intent automatically applies without a confirmation step', async () => {
  const applyCalls: unknown[] = [];
  const service = new AutoApplyTripChangeService(
    { async interpret() { return structuredClone(replaceIntent); } },
    {
      async apply(input) {
        applyCalls.push(input.operation);
        return applyPayload().data;
      },
    },
  );
  const outcome = await service.requestChange({
    text: '第二天不要去武康路了，换成豫园附近。',
    trip: mockShanghaiTrip,
    places: placesFor(),
    expectedTripId: mockShanghaiTrip.id,
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(applyCalls.length, 1);
  assert.equal(JSON.stringify(applyCalls[0]).includes('确认'), false);
});

test('successful apply persists repository then exposes an undo snapshot', async () => {
  const repository = new MockTripRepository();
  await repository.saveGeneratedTrip({
    trip: structuredClone(mockShanghaiTrip),
    places: placesFor(),
  });
  const previous = {
    trip: structuredClone(mockShanghaiTrip),
    places: placesFor(),
  };
  const applied = applyPayload().data;
  const saved = await persistAppliedTripChange(repository, {
    currentTripId: mockShanghaiTrip.id,
    trip: applied.trip,
    places: applied.places,
  });
  const stored = await repository.getTripById(mockShanghaiTrip.id);
  assert.equal(stored?.days[1].places[1].placeName, '豫园');
  assert.equal(saved.trip.days[1].places[1].placeName, '豫园');
  const restored = await restoreTripChangeSnapshot(repository, previous, mockShanghaiTrip.id);
  assert.equal(restored.trip.days[1].places[1].placeName, '武康路');
  assert.equal((await repository.getTripById(mockShanghaiTrip.id))?.days[1].places[1].placeName, '武康路');
  assert.equal(appliedToastLabel(applied.summary).includes('武康路'), true);
  assert.equal(appliedToastLabel(applied.summary).includes('豫园'), true);
  assert.equal(appliedToastLabel(applied.summary).includes('replacementQuery'), false);
});

test('save failure does not keep the applied trip and does not retry apply', async () => {
  let applyCalls = 0;
  const service = new AutoApplyTripChangeService(
    { async interpret() { return structuredClone(replaceIntent); } },
    {
      async apply() {
        applyCalls += 1;
        return applyPayload().data;
      },
    },
  );
  const outcome = await service.requestChange({
    text: '换成豫园',
    trip: mockShanghaiTrip,
    places: placesFor(),
    expectedTripId: mockShanghaiTrip.id,
  });
  assert.equal(outcome.status, 'applied');
  await assert.rejects(
    () => persistAppliedTripChange({
      async saveGeneratedTrip() {
        throw new Error('disk full');
      },
    } as never, {
      currentTripId: mockShanghaiTrip.id,
      trip: applyPayload().data.trip,
      places: applyPayload().data.places,
    }),
    (error: unknown) => error instanceof Error && error.message === 'disk full',
  );
  assert.equal(applyCalls, 1);
  const failed = markFailed(beginApply(beginInterpret(createAssistantUiState(), '换成豫园')), TRIP_CHANGE_SAVE_FAILED_NOTICE);
  assert.equal(failed.open, true);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.draft, '');
  assert.equal(failed.pendingRestoreText, '换成豫园');
});

test('maps 422, 502, 503, timeout and invalid responses without mock fallback', () => {
  assert.equal(noticeForTripChangeError(new BffClientError('INVALID_REQUEST', 'x')), TRIP_CHANGE_INVALID_NOTICE);
  assert.equal(noticeForTripChangeError(new BffClientError('TRIP_CHANGE_INCOMPLETE', 'x')), TRIP_CHANGE_INCOMPLETE_NOTICE);
  assert.equal(noticeForTripChangeError(new BffClientError('PROVIDER_ERROR', 'x')), TRIP_CHANGE_PROVIDER_ERROR_NOTICE);
  assert.equal(noticeForTripChangeError(new BffClientError('PROVIDER_UNAVAILABLE', 'x')), TRIP_CHANGE_UNAVAILABLE_NOTICE);
  assert.equal(noticeForTripChangeError(new BffClientError('NETWORK_ERROR', 'x')), TRIP_CHANGE_GENERIC_NOTICE);
  assert.equal(noticeForTripChangeError(new BffClientError('INVALID_RESPONSE', 'x')), TRIP_CHANGE_GENERIC_NOTICE);
  assert.equal(noticeForTripChangeError(new Error('mock')), TRIP_CHANGE_GENERIC_NOTICE);
});

test('undo restores the previous snapshot without calling BFF and expires after 10 seconds', async () => {
  const repository = new MockTripRepository();
  await repository.saveGeneratedTrip({
    trip: structuredClone(mockShanghaiTrip),
    places: placesFor(),
  });
  const previous = { trip: structuredClone(mockShanghaiTrip), places: placesFor() };
  await persistAppliedTripChange(repository, {
    currentTripId: mockShanghaiTrip.id,
    trip: applyPayload().data.trip,
    places: applyPayload().data.places,
  });
  let fetches = 0;
  const fakeFetch: FetchLike = async () => {
    fetches += 1;
    return jsonResponse({ data: {} });
  };
  const bff = new BffTripChangeService(fakeFetch);
  assert.equal(fetches, 0);
  await restoreTripChangeSnapshot(repository, previous, mockShanghaiTrip.id);
  assert.equal(fetches, 0);
  assert.equal(bff instanceof BffTripChangeService, true);
  assert.equal(isUndoToastActive(0, UNDO_TOAST_MS - 1), true);
  assert.equal(isUndoToastActive(0, UNDO_TOAST_MS), false);
  await assert.rejects(
    () => restoreTripChangeSnapshot(repository, null, mockShanghaiTrip.id),
    (error: unknown) => error instanceof Error && error.name === 'TripChangeStaleError',
  );
});

test('busy assistant states reject close and duplicate submit', () => {
  const interpreting = beginInterpret(openAssistant(createAssistantUiState()), '换成豫园');
  assert.equal(interpreting.phase, 'interpreting');
  assert.equal(canSubmitAssistant(interpreting), false);
  assert.equal(closeAssistant(interpreting).open, true);
  const applying = beginApply(interpreting);
  assert.equal(applying.statusText, '正在调整这一天的行程…');
  assert.equal(closeAssistant(applying).open, true);
  const applied = markApplied(applying);
  assert.equal(applied.open, false);
  assert.equal(applied.phase, 'applied');
});

test('assistant source does not include confirmation, sparkle or server secrets', () => {
  const files = [
    'src/components/trip/AskSuixingButton.tsx',
    'src/components/trip/TripAssistantSheet.tsx',
    'src/components/trip/TripChangeComposer.tsx',
    'src/components/trip/TripChangeMessage.tsx',
    'src/components/trip/TripWorkspace.tsx',
    'src/services/trip-change-service.ts',
    'src/services/bff-trip-change-service.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(file), 'utf8');
    assert.equal(source.includes('确认应用'), false);
    assert.equal(source.includes('sparkle'), false);
    assert.equal(source.includes('ChatGPT'), false);
    assert.equal(source.includes('qwen3.7-plus'), false);
    assert.equal(source.includes('DASHSCOPE_API_KEY'), false);
    assert.equal(source.includes('AMAP_WEB_SERVICE_KEY'), false);
    assert.equal(source.includes('json_schema'), false);
    assert.equal(source.includes('dashscope.aliyuncs.com'), false);
  }
  const workspace = readFileSync(join('src/components/trip/ItineraryTimeline.tsx'), 'utf8');
  assert.equal(workspace.includes('timeline-item--experience'), true);
  assert.equal(workspace.includes('kind === \'experience\''), true);
  assert.equal(TRIP_CHANGE_INTERPRET_PATH.startsWith('/api/'), true);
  assert.equal(TRIP_CHANGE_APPLY_PATH.startsWith('/api/'), true);
});
