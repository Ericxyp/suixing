import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tripPreferenceTags } from '../src/services/trip-display';
import { mockShanghaiTrip } from '../src/mocks/trips';

test('hero and day pill source use real trip fields', () => {
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  const hero = readFileSync('src/components/trip/TripHero.tsx', 'utf8');
  const switcher = readFileSync('src/components/trip/TripDaySwitcher.tsx', 'utf8');
  const timeline = readFileSync('src/components/trip/ItineraryTimeline.tsx', 'utf8');
  assert.equal(hero.includes('随行 · {trip.destination}'), true);
  assert.equal(hero.includes('经典文化'), false);
  assert.equal(switcher.includes('visibleUserText(item.title)'), true);
  assert.equal((workspace.match(/<TripMap[\s\n]/g) || []).length, 1);
  assert.equal(workspace.includes('ItineraryTimeline'), true);
  assert.equal(workspace.includes('TripMapRail'), true);
  assert.equal(workspace.includes('day-workspace--${view}'), true);
  assert.equal(workspace.includes('问随行 · 调整这一天'), true);
  assert.equal(timeline.includes('timeline-item--meal-slot'), true);
  assert.equal(timeline.includes('在地图查看'), true);
  assert.equal(timeline.includes('柔性餐饮'), true);
  assert.equal(timeline.includes('kind === \'experience\''), true);
  assert.equal(timeline.includes('timeline-item--experience'), true);
  const mealSlotBlock = timeline.slice(
    timeline.indexOf("item.kind === 'meal_slot'"),
    timeline.indexOf('const place = placeById.get(item.tripPlaceId)'),
  );
  assert.equal(mealSlotBlock.includes('在地图查看'), false);
  assert.equal(mealSlotBlock.includes('看看吃什么'), true);
});

test('workspace layout css is split on desktop and tabbed on narrow screens', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  assert.equal(css.includes('.day-workspace--itinerary'), true);
  assert.equal(css.includes('minmax(0, 58%)'), true);
  assert.equal(css.includes('minmax(340px, 42%)'), true);
  assert.equal(css.includes('@media (max-width: 767px)'), true);
  assert.equal(css.includes('@media (min-width: 768px) and (max-width: 899px)'), true);
  assert.equal(css.includes('@media (min-width: 900px)'), true);
  assert.equal(css.includes('#3b82f6') || css.includes('#3B82F6'), true);
  assert.equal(css.includes('trip-map-pin__dot'), true);
  assert.equal(css.includes('overflow-x: auto'), true);
  assert.equal(css.includes('text-overflow: ellipsis'), true);
  assert.equal(css.includes('-webkit-line-clamp: 2'), true);
  assert.equal(css.includes('.ask-suixing-entry-slot--mobile'), true);
  assert.equal(css.includes('env(safe-area-inset-bottom'), true);
  assert.equal(css.includes('min-height: 44px'), true);
  assert.equal(css.includes('li:nth-child(n + 3)'), true);
  assert.equal(css.includes('.entry-page--workspace .change-toast'), true);
});

test('narrow layout keeps a single map and restores size after tab change', () => {
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  const map = readFileSync('src/components/trip/TripMap.tsx', 'utf8');
  const switcher = readFileSync('src/components/trip/TripDaySwitcher.tsx', 'utf8');
  const layout = readFileSync('src/services/trip-workspace-layout.ts', 'utf8');
  assert.equal((workspace.match(/<TripMap[\s\n]/g) || []).length, 1);
  assert.equal(workspace.includes('layoutSignal={view}'), true);
  assert.equal(map.includes('restoreTripMapViewport'), true);
  assert.equal(switcher.includes('scrollIntoView'), true);
  assert.equal(layout.includes('WORKSPACE_PHONE_QUERY'), true);
  assert.equal(layout.includes('innerWidth'), false);
  assert.equal(workspace.includes('innerWidth'), false);
  assert.equal(workspace.includes('assistantLayoutForViewport'), true);
});

test('no-preference trips do not invent tags', () => {
  const trip = { ...mockShanghaiTrip, preferences: { interests: [] } };
  assert.deepEqual(tripPreferenceTags(trip), []);
});

test('desktop split helper uses CSS media query, not a one-shot innerWidth snapshot', () => {
  const source = readFileSync('src/services/trip-workspace-layout.ts', 'utf8');
  assert.equal(source.includes('WORKSPACE_SPLIT_QUERY'), true);
  assert.equal(source.includes('min-width: 900px'), true);
  assert.equal(source.includes('innerWidth'), false);
});

test('map rail and trip map expose a single instance marker', () => {
  const rail = readFileSync('src/components/trip/TripMapRail.tsx', 'utf8');
  const map = readFileSync('src/components/trip/TripMap.tsx', 'utf8');
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  assert.equal(rail.includes('data-map-instance="1"'), true);
  assert.equal(map.includes('data-trip-map="primary"'), true);
  assert.equal(workspace.split('<TripMapRail').length - 1, 1);
  assert.equal(workspace.includes('setView(\'itinerary\')'), true);
});

test('frontend workspace sources do not add secrets or leak tokens', () => {
  const files = [
    'src/components/trip/TripWorkspace.tsx',
    'src/components/trip/TripMap.tsx',
    'src/components/trip/AskSuixingButton.tsx',
    'src/components/trip/ItineraryTimeline.tsx',
    'src/components/trip/TripHero.tsx',
    'src/services/trip-map.ts',
    'src/services/trip-display.ts',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('${s.type}'), false, file);
    assert.equal(source.includes('$(s.type)'), false, file);
    assert.equal(source.includes('DASHSCOPE_API_KEY'), false, file);
    assert.equal(source.includes('AMAP_WEB_SERVICE_KEY'), false, file);
    assert.equal(source.includes('qwen3.7-plus'), false, file);
    assert.equal(source.includes('dashscope.aliyuncs.com'), false, file);
    assert.equal(source.includes('restapi.amap.com'), false, file);
  }
});
