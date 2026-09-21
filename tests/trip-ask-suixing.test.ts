import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mockShanghaiTrip } from '../src/mocks/trips';
import {
  ASK_SUIXING_CAPABILITY,
  ASK_SUIXING_HINT,
  askSuixingDayLabel,
  askSuixingDaySummary,
  askSuixingExamples,
  askSuixingPlaceholder,
} from '../src/services/ask-suixing-display';
import {
  ASK_SUIXING_BREAKPOINT_PX,
  ASK_SUIXING_EXAMPLES,
  beginInterpret,
  canSubmitAssistant,
  closeAssistant,
  createAssistantUiState,
  markFailed,
  openAssistant,
  restoreFailedDraft,
  sheetLayoutForWidth,
} from '../src/services/trip-assistant-session';

test('ask suixing context and examples come from the real current day', () => {
  const day = mockShanghaiTrip.days[0];
  const label = askSuixingDayLabel(day);
  const summary = askSuixingDaySummary(mockShanghaiTrip, day);
  const examples = askSuixingExamples(day);
  const placeholder = askSuixingPlaceholder(day);
  assert.equal(label.startsWith('Day 1 ·'), true);
  assert.equal(label.includes(day.title ?? ''), true);
  assert.equal(summary.includes('个地点'), true);
  assert.equal(examples.length, 3);
  assert.equal(examples.includes('把下午的地点换成附近博物馆'), true);
  assert.equal(examples.includes('换成一家咖啡馆'), true);
  assert.equal(examples.some((item) => item.includes('不要去') && item.includes('换成附近博物馆')), true);
  assert.equal(placeholder.includes('长城'), false);
  assert.equal(placeholder.includes('北京'), false);
  assert.equal(JSON.stringify(examples).includes('预订'), false);
  assert.equal(JSON.stringify(examples).includes('加景点'), false);
});

test('generic fallback examples stay replace-only and do not hardcode Beijing', () => {
  assert.equal((ASK_SUIXING_EXAMPLES as readonly string[]).includes('第二天不要去长城，换成颐和园'), false);
  assert.equal(ASK_SUIXING_HINT.includes('替换'), true);
  assert.equal(ASK_SUIXING_CAPABILITY.includes('订票'), false);
});

test('desktop ask sheet uses CSS 900px rail and a single mount', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  const workspace = readFileSync('src/components/trip/TripWorkspace.tsx', 'utf8');
  const sheet = readFileSync('src/components/trip/TripAssistantSheet.tsx', 'utf8');
  const composer = readFileSync('src/components/trip/TripChangeComposer.tsx', 'utf8');
  assert.equal(sheetLayoutForWidth(1280), 'side');
  assert.equal(sheetLayoutForWidth(ASK_SUIXING_BREAKPOINT_PX), 'bottom');
  assert.equal(sheetLayoutForWidth(900), 'side');
  assert.equal(css.includes('.ask-suixing-layer'), true);
  assert.equal(css.includes('width: 460px'), true);
  assert.equal((workspace.split('<TripAssistantSheet').length - 1), 1);
  assert.equal(workspace.includes('ask-suixing-sheet--side'), false);
  assert.equal(workspace.includes('mealSheet && !assistant.open'), true);
  assert.equal(sheet.includes('aria-label="关闭问随行"'), true);
  assert.equal(sheet.includes('inputRef.current?.focus()'), true);
  assert.equal(composer.includes('正在调整…'), true);
  assert.equal(composer.includes('!value.trim()'), true);
  assert.equal(sheet.includes('替换为这里'), true);
  assert.equal(workspace.includes('replacementQuery: candidate.placeId'), true);
  assert.equal(workspace.includes('replacementQuery: candidate.name'), false);
  assert.equal(workspace.includes('replacementQuery: placeName'), false);
  assert.equal(composer.includes('重新编辑'), true);
  assert.equal(composer.includes('onChange(example)'), true);
  assert.equal(composer.includes('interpret('), false);
  assert.equal(sheet.includes('TRIP_CHANGE_INCOMPLETE'), false);
  assert.equal(sheet.includes('qwen'), false);
  assert.equal(workspace.includes('askTriggerRef'), true);
});

test('busy assistant still blocks close and a second submit', () => {
  const busy = beginInterpret(openAssistant(createAssistantUiState()), '换成咖啡馆');
  assert.equal(canSubmitAssistant(busy), false);
  assert.equal(closeAssistant(busy).open, true);
  const failed = markFailed(busy, '暂时无法调整行程，请稍后重试。');
  assert.equal(failed.open, true);
  assert.equal(failed.draft, '');
  assert.equal(failed.pendingRestoreText, '换成咖啡馆');
  assert.equal(failed.error, '暂时无法调整行程，请稍后重试。');
  assert.equal(failed.messages.some((item) => item.content === failed.error), false);
  const closed = closeAssistant(failed);
  assert.equal(closed.open, false);
  assert.equal(closed.messages.length, 0);
  assert.equal(closed.pendingRestoreText, null);
});
