import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mockShanghaiTrip } from '../src/mocks/trips';
import {
  applyInspirationChip,
  HOME_INSPIRATION_CHIPS,
  tripCoverInitial,
  tripCoverTone,
  tripHomeStatusLabel,
} from '../src/services/home-presentation';

test('inspiration chips only fill the request text and never invent destinations', () => {
  assert.deepEqual([...HOME_INSPIRATION_CHIPS], ['周末短途', '城市漫步', '美食旅行', '海边度假']);
  assert.equal(applyInspirationChip('', '周末短途'), '周末短途');
  assert.equal(applyInspirationChip('想慢慢逛', '城市漫步'), '想慢慢逛，城市漫步');
  assert.equal(applyInspirationChip('城市漫步', '城市漫步'), '城市漫步');
  assert.equal(HOME_INSPIRATION_CHIPS.some((chip) => /上海|北京|杭州/.test(chip)), false);
});

test('trip cards use destination tones instead of remote photos', () => {
  assert.equal(tripCoverTone('上海'), tripCoverTone('上海'));
  assert.equal(tripCoverInitial('北京'), '北');
  assert.equal(tripHomeStatusLabel(mockShanghaiTrip), '规划中');
  assert.equal(tripHomeStatusLabel({ ...mockShanghaiTrip, status: 'READY' }), null);
});

test('homepage presentation stays on the existing generate and repository flow', () => {
  const home = readFileSync('src/pages/HomePage.tsx', 'utf8');
  const entry = readFileSync('src/components/home/CreateTripEntry.tsx', 'utf8');
  const recent = readFileSync('src/components/home/RecentTripsSection.tsx', 'utf8');
  const css = readFileSync('src/styles/global.css', 'utf8');

  assert.match(home, /selectRecentTrips/);
  assert.match(home, /deleteTrip/);
  assert.match(home, /RecentTripsSection/);
  assert.equal(home.includes('TripSection'), false);
  assert.equal(home.includes('unsplash'), false);
  assert.equal(home.includes('http://'), false);
  assert.equal(home.includes('https://'), false);

  assert.match(entry, /parseHomeTripRequest/);
  assert.match(entry, /applyInspirationChip/);
  assert.match(entry, /type="button"/);
  assert.match(entry, /type="submit"/);
  assert.equal(entry.includes('navigate(parsed.path'), true);
  assert.equal(entry.includes('generate('), false);

  assert.match(recent, /\/trips\/\$\{trip\.id\}/);
  assert.match(recent, /window\.confirm/);
  assert.match(recent, /删除/);
  assert.match(recent, /recent-trips__empty/);
  assert.equal(recent.includes('<img'), false);
  assert.equal(recent.includes('http'), false);
  assert.equal(recent.includes('查看全部行程'), false);

  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(css.includes('day-workspace--itinerary'), true);
});
