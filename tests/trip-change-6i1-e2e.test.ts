import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { AiProviderError } from '../server/services/ai-provider';
import type { Place } from '../src/domain/trip/types';
import { mockShanghaiTrip } from '../src/mocks/trips';
import { BffTripChangeService } from '../src/services/bff-trip-change-service';
import {
  beginInterpret,
  createAssistantUiState,
  showChoices,
} from '../src/services/trip-assistant-session';
import { TRIP_CHANGE_INVALID_NOTICE } from '../src/services/trip-change-service';

const config: ServerConfig = {
  port: 3000,
  amapWebServiceKey: undefined,
  hasAmapWebServiceKey: false,
  hasAmapSecurityJsCode: false,
  hasQwenAiProvider: false,
};

const malls: Place[] = [
  { id: 'place-xintiandi', provider: 'mock', providerPlaceId: 'mock-sh-005', name: '新天地', address: '上海市', latitude: 31.2204, longitude: 121.4754, category: 'shopping' },
  { id: 'mall-taikoo', provider: 'mock', providerPlaceId: 'mall-1', name: '兴业太古汇', address: '上海市', latitude: 31.221, longitude: 121.476, category: 'shopping' },
  { id: 'mall-iapm', provider: 'mock', providerPlaceId: 'mall-2', name: '环贸iapm', address: '上海市', latitude: 31.218, longitude: 121.46, category: 'shopping' },
  { id: 'mall-hkri', provider: 'mock', providerPlaceId: 'mall-3', name: '静安嘉里中心', address: '上海市', latitude: 31.23, longitude: 121.45, category: 'shopping' },
  { id: 'mall-park', provider: 'mock', providerPlaceId: 'mall-park', name: '新天地停车场', address: '上海市', latitude: 31.22, longitude: 121.47, category: 'attraction' },
];

async function withInterpretService<T>(
  run: (service: BffTripChangeService) => Promise<T>,
): Promise<T> {
  const server = createServer(createApp(config, {
    tripChangeIntentExtractor: {
      async interpret() {
        throw new AiProviderError('AI_INVALID_RESPONSE', 'RAW_UPSTREAM not json');
      },
    },
    placeSearchService: {
      async search() {
        return structuredClone(malls);
      },
      async getByProviderPlaceId() {
        return null;
      },
    },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Temporary server failed to bind.');
  }
  const service = new BffTripChangeService(async (input, init) => {
    const path = String(input);
    return fetch(`http://127.0.0.1:${address.port}${path}`, init);
  });
  try {
    return await run(service);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('original unpunctuated mall replace goes through BFF client focus and shows choice cards', async () => {
  const phrase = '不想去新天地换一个商场';
  const before = structuredClone(mockShanghaiTrip);
  await withInterpretService(async (service) => {
    const intent = await service.interpret(phrase, mockShanghaiTrip, { selectedDayNumber: 1 });
    assert.equal(intent.status, 'needs_choice');
    assert.equal(intent.pendingReplace?.targetTripPlaceId, 'tp-d1-xintiandi');
    assert.equal(intent.pendingReplace?.dayNumber, 1);
    assert.equal(intent.operations.length, 0);
    const names = (intent.candidates ?? []).map((item) => item.name);
    assert.equal(names.length >= 3 && names.length <= 5, true);
    assert.equal(names.includes('新天地'), false);
    assert.equal(names.includes('新天地停车场'), false);
    assert.equal(JSON.stringify(intent).includes('intentType'), false);
    assert.equal(JSON.stringify(intent).includes(TRIP_CHANGE_INVALID_NOTICE), false);
    const ui = showChoices(
      beginInterpret(createAssistantUiState(), phrase),
      intent.summary,
      intent.candidates ?? [],
      intent.pendingReplace,
    );
    assert.equal(ui.phase, 'needs_choice');
    assert.equal(ui.error, null);
    assert.equal(ui.candidates.length >= 3, true);
    assert.equal(ui.messages.some((item) => item.content.includes('无法理解')), false);
    assert.deepEqual(mockShanghaiTrip, before);
  });
});

test('punctuated and nearby mall phrases also return choices through the BFF client', async () => {
  const phrases = [
    '不想去新天地，换一个商场',
    '不去新天地了，换个别的商场',
    '给我几个附近商场',
  ];
  await withInterpretService(async (service) => {
    for (const phrase of phrases) {
      const intent = await service.interpret(phrase, mockShanghaiTrip, {
        selectedDayNumber: 1,
        sourceTripPlaceId: phrase.includes('附近') ? 'tp-d1-xintiandi' : undefined,
      });
      assert.equal(intent.status, 'needs_choice', phrase);
      assert.equal(intent.pendingReplace?.targetTripPlaceId, 'tp-d1-xintiandi', phrase);
      assert.equal((intent.candidates ?? []).some((item) => item.name === '新天地'), false, phrase);
    }
  });
});

test('choice click reuses replace apply and does not change trip beforehand', async () => {
  const phrase = '不想去新天地换一个商场';
  await withInterpretService(async (interpretService) => {
    const intent = await interpretService.interpret(phrase, mockShanghaiTrip, { selectedDayNumber: 1 });
    const snapshot = structuredClone(mockShanghaiTrip);
    assert.deepEqual(mockShanghaiTrip, snapshot);
    const chosen = intent.candidates?.[0];
    assert.ok(chosen);
    assert.ok(intent.pendingReplace);
    const operation = {
      type: 'REPLACE_PLACE' as const,
      dayNumber: intent.pendingReplace.dayNumber,
      targetTripPlaceId: intent.pendingReplace.targetTripPlaceId,
      replacementQuery: chosen.name,
    };
    assert.equal(operation.type, 'REPLACE_PLACE');
    assert.equal(operation.targetTripPlaceId, 'tp-d1-xintiandi');
    assert.equal(operation.replacementQuery === '新天地', false);
    assert.equal(mockShanghaiTrip.days[0]?.places.find((place) => place.id === 'tp-d1-xintiandi')?.placeName, '新天地');
  });
});
