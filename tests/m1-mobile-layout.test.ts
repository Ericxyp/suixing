import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

test('M1 CSS keeps three layout breakpoints and no one-shot width layout', () => {
  const css = read('src/styles/global.css');
  const workspace = read('src/components/trip/TripWorkspace.tsx');
  const layout = read('src/services/trip-workspace-layout.ts');
  const planPage = read('src/pages/PlanConversationPage.tsx');

  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 899px\)/);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /@media \(max-width: 899px\)/);

  assert.equal(css.includes('100vw'), false);
  assert.equal(layout.includes('innerWidth'), false);
  assert.equal(workspace.includes('innerWidth'), false);
  assert.equal(planPage.includes('innerWidth'), false);
  assert.match(workspace, /assistantLayoutForViewport/);
  assert.match(workspace, /matchMedia/);
});

test('M1 trip tabs hide map rail or timeline and keep one primary map', () => {
  const css = read('src/styles/global.css');
  const workspace = read('src/components/trip/TripWorkspace.tsx');
  const map = read('src/components/trip/TripMap.tsx');
  const rail = read('src/components/trip/TripMapRail.tsx');

  assert.match(css, /\.day-workspace--itinerary \.trip-map-rail\s*\{\s*display:\s*none/);
  assert.match(css, /\.day-workspace--map \.day-workspace__timeline\s*\{\s*display:\s*none/);
  assert.match(css, /minmax\(0, 58%\)/);
  assert.match(css, /minmax\(340px, 42%\)/);

  assert.equal((workspace.match(/<TripMap[\s\n]/g) || []).length, 1);
  assert.equal(workspace.split('<TripMapRail').length - 1, 1);
  assert.match(map, /data-trip-map="primary"/);
  assert.match(rail, /data-map-instance="1"/);
  assert.match(workspace, /layoutSignal=\{view\}/);
  assert.match(map, /restoreTripMapViewport/);
});

test('M1 Ask / Toast / sheets use safe-area and avoid stacking collisions', () => {
  const css = read('src/styles/global.css');
  const workspace = read('src/components/trip/TripWorkspace.tsx');

  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /padding-bottom: calc\(88px \+ env\(safe-area-inset-bottom/);
  assert.match(css, /\.ask-suixing-entry[\s\S]*bottom: calc\(16px \+ env\(safe-area-inset-bottom/);
  assert.match(css, /82dvh/);
  assert.match(css, /\.ask-suixing-entry-slot--hidden/);
  assert.match(css, /z-index: 34/);
  assert.match(workspace, /ask-suixing-entry-slot--hidden/);
  assert.match(workspace, /setMealSheet\(null\)/);
  assert.match(workspace, /closeAssistant/);
  assert.equal(workspace.includes('MealOptionsSheet') && workspace.includes('TripAssistantSheet'), true);
  assert.match(workspace, /mealSheet && !assistant\.open/);
});

test('M1 hero tags, day pills, and plan style cards stay narrow-screen safe', () => {
  const css = read('src/styles/global.css');
  const switcher = read('src/components/trip/TripDaySwitcher.tsx');
  const conversation = read('src/components/plan/PlanConversation.tsx');

  assert.match(css, /\.trip-hero__tags li:nth-child\(n \+ 3\)/);
  assert.match(css, /\.trip-hero__tags li:nth-child\(n \+ 4\)/);
  assert.match(css, /\.day-switcher button\s*\{\s*min-width: 128px/);
  assert.match(css, /\.plan-message\s*\{[\s\S]*max-width: 88%/);
  assert.match(css, /\.plan-conversation__dock[\s\S]*position: sticky/);
  assert.match(css, /\.trip-style-card,\s*\.trip-style-editor\s*\{[\s\S]*max-width: 100%/);
  assert.match(switcher, /scrollIntoView/);
  assert.match(conversation, /TripStyleSummaryCard/);
  assert.match(conversation, /TripStyleEditor/);
});

test('M1 home and sheets keep 44px touch targets without leaking secrets', () => {
  const css = read('src/styles/global.css');
  const home = read('src/pages/HomePage.tsx');
  const meal = read('src/components/trip/MealOptionsSheet.tsx');
  const ask = read('src/components/trip/TripAssistantSheet.tsx');
  const files = [
    'src/pages/HomePage.tsx',
    'src/pages/PlanConversationPage.tsx',
    'src/components/trip/TripWorkspace.tsx',
    'src/components/trip/MealOptionsSheet.tsx',
    'src/components/trip/TripAssistantSheet.tsx',
    'src/styles/global.css',
  ];

  assert.match(css, /min-height: 44px/);
  assert.match(css, /\.home-chips[\s\S]*overflow-x: auto/);
  assert.match(css, /\.recent-trip-list[\s\S]*grid-template-columns: 1fr/);
  assert.match(meal, /aria-label="关闭用餐安排"/);
  assert.match(ask, /aria-label="关闭问随行"/);
  assert.equal(home.includes('window.innerWidth'), false);

  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('DASHSCOPE_API_KEY'), false, file);
    assert.equal(source.includes('AMAP_WEB_SERVICE_KEY'), false, file);
    assert.equal(/['"`]sk-[a-zA-Z0-9]/.test(source), false, file);
    assert.equal(source.includes('qwen3.7-plus'), false, file);
  }
});
