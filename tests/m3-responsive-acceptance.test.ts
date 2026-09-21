import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8');
const workspace = readFileSync(join(process.cwd(), 'src/components/trip/TripWorkspace.tsx'), 'utf8');
const map = readFileSync(join(process.cwd(), 'src/components/trip/TripMap.tsx'), 'utf8');

test('M3 mobile sheets lift with keyboard inset without double-padding the composer', () => {
  const askMobile = css.slice(css.indexOf('@media (max-width: 899px) {\n  .ask-suixing-sheet'));
  const askBlock = askMobile.slice(0, askMobile.indexOf('\n}') + 2);
  assert.match(askBlock, /bottom:\s*var\(--suixing-keyboard-inset/);

  const composerStart = css.indexOf('.trip-change-composer {');
  const composerBase = css.slice(composerStart, css.indexOf('}', composerStart) + 1);
  assert.match(composerBase, /env\(safe-area-inset-bottom/);
  assert.equal(composerBase.includes('var(--suixing-keyboard-inset'), false);

  const mealFeedbackStart = css.indexOf('.meal-options-sheet__feedback');
  const mealFeedback = css.slice(mealFeedbackStart, css.indexOf('}', mealFeedbackStart) + 1);
  assert.equal(mealFeedback.includes('var(--suixing-keyboard-inset'), false);

  assert.match(css, /\.ask-suixing-sheet\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.ask-suixing-sheet__stream\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /\.meal-options-sheet\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.meal-options-sheet__body\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /\.ask-suixing-sheet \.trip-change-composer[\s\S]*max-height:\s*55%/);
  assert.match(css, /\.ask-suixing-sheet \.trip-change-composer textarea[\s\S]*min-height:\s*56px/);

  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.day-workspace--itinerary[\s\S]*minmax\(0, 58%\)/);
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*\.day-workspace--itinerary \.trip-map-rail[\s\S]*display:\s*none/);
});

test('M3 keeps a single primary map and Ask/Meal mutual exclusion', () => {
  assert.equal((workspace.match(/<TripMap[\s\n]/g) || []).length, 1);
  assert.match(map, /data-trip-map="primary"/);
  assert.match(map, /isUsableMapContainer/);
  assert.match(workspace, /mealSheet && !assistant\.open/);
  assert.equal(workspace.includes('innerWidth'), false);
  assert.equal(map.includes('DASHSCOPE_API_KEY'), false);
  assert.equal(workspace.includes('validationReason'), false);
});
