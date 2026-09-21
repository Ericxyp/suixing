import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  computeKeyboardInsetPx,
  formatKeyboardInsetCss,
  isUsableMapContainer,
  lockBackgroundScroll,
  SHEET_SCROLL_LOCK_QUERY,
  SUIXING_KEYBOARD_INSET_VAR,
  subscribeKeyboardInset,
  type WindowLike,
} from '../src/services/mobile-viewport';

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

test('keyboard inset is zero without visualViewport and formats safely', () => {
  assert.equal(computeKeyboardInsetPx(undefined), 0);
  assert.equal(computeKeyboardInsetPx(null), 0);
  assert.equal(computeKeyboardInsetPx({ innerHeight: 800 }), 0);
  assert.equal(computeKeyboardInsetPx({
    innerHeight: 800,
    visualViewport: { height: 500, offsetTop: 40 },
  }), 260);
  assert.equal(computeKeyboardInsetPx({
    innerHeight: 800,
    visualViewport: { height: 900, offsetTop: 0 },
  }), 0);
  assert.equal(formatKeyboardInsetCss(12.6), '13px');
  assert.equal(formatKeyboardInsetCss(-4), '0px');
  assert.equal(formatKeyboardInsetCss(Number.NaN), '0px');
});

test('subscribeKeyboardInset no-ops without window and cleans up listeners with rAF merge', () => {
  subscribeKeyboardInset(undefined, undefined).disconnect();

  const listeners = new Map<string, Set<() => void>>();
  let frame = 0;
  const queued: Array<() => void> = [];
  const rootStyle = new Map<string, string>();
  const viewport = {
    height: 600,
    offsetTop: 0,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const win: WindowLike = {
    innerHeight: 800,
    visualViewport: viewport,
    requestAnimationFrame(cb) {
      queued.push(() => cb(frame));
      return ++frame;
    },
    cancelAnimationFrame() {},
  };
  const root = {
    style: {
      setProperty(name: string, value: string) {
        rootStyle.set(name, value);
      },
    },
  };

  const sub = subscribeKeyboardInset(win, root);
  assert.equal(rootStyle.get(SUIXING_KEYBOARD_INSET_VAR), '200px');
  assert.equal(listeners.get('resize')?.size, 1);
  assert.equal(listeners.get('scroll')?.size, 1);

  viewport.height = 520;
  listeners.get('resize')?.forEach((fn) => fn());
  listeners.get('resize')?.forEach((fn) => fn());
  assert.equal(queued.length, 1);
  queued.shift()?.();
  assert.equal(rootStyle.get(SUIXING_KEYBOARD_INSET_VAR), '280px');

  sub.disconnect();
  assert.equal(rootStyle.get(SUIXING_KEYBOARD_INSET_VAR), '0px');
  assert.equal(listeners.get('resize')?.size ?? 0, 0);
  assert.equal(listeners.get('scroll')?.size ?? 0, 0);
});

test('background scroll lock is narrow-only and restores scrollY', () => {
  let scrollY = 120;
  const body = {
    classList: {
      values: new Set<string>(),
      add(name: string) { this.values.add(name); },
      remove(name: string) { this.values.delete(name); },
    },
    style: {
      overflow: '',
      position: '',
      top: '',
      width: '',
    },
  } as unknown as HTMLElement;
  const win: WindowLike = {
    innerHeight: 800,
    scrollY,
    matchMedia: (query) => ({ matches: query === SHEET_SCROLL_LOCK_QUERY }),
    scrollTo(_x, y) { scrollY = y; },
  };
  const lock = lockBackgroundScroll(win, body);
  assert.equal(body.style.position, 'fixed');
  assert.equal(body.style.top, '-120px');
  lock.unlock();
  assert.equal(body.style.position, '');
  assert.equal(scrollY, 120);

  const desktop = lockBackgroundScroll(
    { ...win, matchMedia: () => ({ matches: false }) },
    body,
  );
  assert.equal(body.style.position, '');
  desktop.unlock();
});

test('map container visibility helper rejects zero-size frames', () => {
  assert.equal(isUsableMapContainer(null), false);
  assert.equal(isUsableMapContainer({ clientWidth: 0, clientHeight: 320 }), false);
  assert.equal(isUsableMapContainer({ clientWidth: 390, clientHeight: 420 }), true);
});

test('M2 CSS wires keyboard inset into plan dock, sheets, toast and ask entry', () => {
  const css = read('src/styles/global.css');
  assert.match(css, /--suixing-keyboard-inset:\s*0px/);
  assert.match(css, /\.plan-conversation__dock[\s\S]*bottom:\s*var\(--suixing-keyboard-inset/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /var\(--suixing-keyboard-inset/);
  assert.match(css, /82dvh/);
  assert.match(css, /82vh/);
  assert.match(css, /\.trip-change-composer[\s\S]*env\(safe-area-inset-bottom/);
  assert.match(css, /\.ask-suixing-sheet[\s\S]*bottom:\s*var\(--suixing-keyboard-inset/);
  assert.match(css, /\.meal-options-sheet[\s\S]*var\(--suixing-keyboard-inset/);
  assert.match(css, /\.ask-suixing-entry[\s\S]*var\(--suixing-keyboard-inset/);
  assert.match(css, /top:\s*calc\(12px \+ env\(safe-area-inset-top/);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.equal(css.includes('100vw'), false);
});

test('M2 wiring keeps single map, mutual exclusion, and no layout-by-innerWidth', () => {
  const workspace = read('src/components/trip/TripWorkspace.tsx');
  const map = read('src/components/trip/TripMap.tsx');
  const plan = read('src/components/plan/PlanConversation.tsx');
  const meal = read('src/components/trip/MealOptionsSheet.tsx');
  const ask = read('src/components/trip/TripAssistantSheet.tsx');
  const viewport = read('src/services/mobile-viewport.ts');

  assert.equal((workspace.match(/<TripMap[\s\n]/g) || []).length, 1);
  assert.match(map, /data-trip-map="primary"/);
  assert.match(map, /isUsableMapContainer/);
  assert.match(map, /visualViewport/);
  assert.match(map, /orientationchange/);
  assert.match(workspace, /mealSheet && !assistant\.open/);
  assert.match(workspace, /subscribeKeyboardInset/);
  assert.match(plan, /subscribeKeyboardInset/);
  assert.match(plan, /stickToLatestRef/);
  assert.match(plan, /editButtonRef/);
  assert.match(meal, /lockBackgroundScroll/);
  assert.match(ask, /lockBackgroundScroll/);
  assert.equal(workspace.includes('innerWidth'), false);
  assert.equal(plan.includes('innerWidth'), false);
  assert.equal(viewport.includes('innerWidth'), false);
  assert.equal(viewport.includes('innerHeight'), true);
  assert.equal(viewport.includes('localStorage'), false);
  assert.match(viewport, /visualViewport/);
});

test('M2 frontend sources do not expose server secrets or validationReason', () => {
  const files = [
    'src/services/mobile-viewport.ts',
    'src/components/plan/PlanConversation.tsx',
    'src/components/trip/TripWorkspace.tsx',
    'src/components/trip/TripMap.tsx',
    'src/components/trip/MealOptionsSheet.tsx',
    'src/components/trip/TripAssistantSheet.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('DASHSCOPE_API_KEY'), false, file);
    assert.equal(source.includes('AMAP_WEB_SERVICE_KEY'), false, file);
    assert.equal(source.includes('validationReason'), false, file);
    assert.equal(/['"`]sk-[a-zA-Z0-9]/.test(source), false, file);
    assert.equal(source.includes('qwen3.7-plus'), false, file);
  }
});
