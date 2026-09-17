import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTripChangePreview,
  type TripChange,
} from '../src/domain/trip/trip-change';
import { mockShanghaiTripChangePreview } from '../src/mocks/trip-changes';
import { mockShanghaiTrip } from '../src/mocks/trips';

test('applying a change preview creates a new Trip without mutating its input', () => {
  const original = structuredClone(mockShanghaiTrip);
  const updated = applyTripChangePreview(original, mockShanghaiTripChangePreview);

  assert.notStrictEqual(updated, original);
  assert.equal(original.totalBudget, 3820);
  assert.equal(updated.totalBudget, 3790);
  assert.ok(original.days[1].places.some((place) => place.id === 'tp-d2-wukang'));
  assert.ok(!original.days[1].places.some((place) => place.placeName === '上海博物馆'));
  assert.ok(!updated.days[1].places.some((place) => place.id === 'tp-d2-wukang'));
  assert.ok(updated.days[1].places.some((place) => place.id === 'preview-tp-d2-museum'));
  assert.equal(updated.days[1].places.filter((place) => place.placeName === '上海博物馆').length, 1);
});

test('a change cannot be applied to another Trip', () => {
  const anotherTrip = { ...mockShanghaiTrip, id: 'trip-other' };

  assert.throws(
    () => applyTripChangePreview(anotherTrip, mockShanghaiTripChangePreview),
    /does not belong/,
  );
});

test('UPDATE changes editable fields without changing the original Trip', () => {
  const original = structuredClone(mockShanghaiTrip);
  const change: TripChange = {
    ...mockShanghaiTripChangePreview,
    id: 'change-update',
    costDelta: 0,
    operations: [{
      type: 'UPDATE',
      dayId: original.days[0].id,
      targetTripPlaceId: 'tp-d1-rac',
      payload: { description: '延长咖啡休息时间。', durationMinutes: 100 },
    }],
  };

  const updated = applyTripChangePreview(original, change);
  const originalPlace = original.days[0].places.find((place) => place.id === 'tp-d1-rac');
  const updatedPlace = updated.days[0].places.find((place) => place.id === 'tp-d1-rac');

  assert.equal(originalPlace?.durationMinutes, 80);
  assert.equal(updatedPlace?.durationMinutes, 100);
  assert.equal(updatedPlace?.description, '延长咖啡休息时间。');
});

test('MOVE reorders places into a continuous unique order without mutating the original Trip', () => {
  const original = structuredClone(mockShanghaiTrip);
  const change: TripChange = {
    ...mockShanghaiTripChangePreview,
    id: 'change-move',
    costDelta: 0,
    operations: [{
      type: 'MOVE',
      dayId: original.days[0].id,
      targetTripPlaceId: 'tp-d1-bund',
      payload: { order: 2 },
    }],
  };

  const updated = applyTripChangePreview(original, change);
  assert.deepEqual(updated.days[0].places.map((place) => place.id), [
    'tp-d1-hotel', 'tp-d1-bund', 'tp-d1-wukang', 'tp-d1-rac', 'tp-d1-xintiandi',
  ]);
  assert.deepEqual(updated.days[0].places.map((place) => place.order), [1, 2, 3, 4, 5]);
  assert.deepEqual(original.days[0].places.map((place) => place.order), [1, 2, 3, 4, 5]);
});

test('invalid UPDATE and MOVE operations throw clear errors without mutating the input', () => {
  const original = structuredClone(mockShanghaiTrip);
  const invalidUpdate: TripChange = {
    ...mockShanghaiTripChangePreview,
    id: 'invalid-update',
    costDelta: 0,
    operations: [{ type: 'UPDATE', dayId: original.days[0].id, payload: { id: 'not-allowed' } }],
  };
  const invalidMove: TripChange = {
    ...mockShanghaiTripChangePreview,
    id: 'invalid-move',
    costDelta: 0,
    operations: [{
      type: 'MOVE', dayId: original.days[0].id, targetTripPlaceId: 'unknown-place', payload: { order: 2 },
    }],
  };

  assert.throws(() => applyTripChangePreview(original, invalidUpdate), /UPDATE requires targetTripPlaceId/);
  assert.throws(() => applyTripChangePreview(original, invalidMove), /MOVE target TripPlace "unknown-place" was not found/);
  assert.deepEqual(original, mockShanghaiTrip);
});
