import assert from 'node:assert/strict';
import test from 'node:test';
import { mockSavedItems } from '../src/mocks/saved-items';
import { mockTrips } from '../src/mocks/trips';
import { MockSavedItemRepository } from '../src/repositories/mock-saved-item-repository';
import { MockTripRepository } from '../src/repositories/mock-trip-repository';

test('getTripsByUserId returns only the requested user trips and clones them', async () => {
  const repository = new MockTripRepository();
  const trips = await repository.getTripsByUserId('user-demo-001');

  assert.equal(trips.length, 3);
  assert.ok(trips.every((trip) => trip.userId === 'user-demo-001'));
  trips[0].title = 'changed';
  assert.equal(mockTrips[0].title, '上海 · 3天2晚');
  assert.deepEqual(await repository.getTripsByUserId('unknown-user'), []);
});

test('getTripById returns null for unknown IDs', async () => {
  const repository = new MockTripRepository();
  assert.equal(await repository.getTripById('unknown-trip'), null);
});

test('getSavedItems returns only the requested user items and clones them', async () => {
  const repository = new MockSavedItemRepository();
  const items = await repository.getSavedItems('user-demo-001');

  assert.equal(items.length, 4);
  assert.ok(items.every((item) => item.userId === 'user-demo-001'));
  items[0].title = 'changed';
  assert.equal(mockSavedItems[0].title, '上海博物馆');
  assert.deepEqual(await repository.getSavedItems('unknown-user'), []);
});
