import type {
  TripChangeCandidate,
  TripChangeFocus,
  TripChangePendingReplace,
  TripChangeSourceChoice,
} from './bff-trip-change-service';

export type AssistantSheetLayout = 'side' | 'bottom';
export type AssistantPhase =
  | 'idle'
  | 'interpreting'
  | 'needs_clarification'
  | 'needs_choice'
  | 'applying'
  | 'applied'
  | 'failed';

export const ASK_SUIXING_BREAKPOINT_PX = 899;
export const ASK_SUIXING_EXAMPLES = [
  '把下午的地点换成附近博物馆',
  '换成一家咖啡馆',
  '把今天的地点换成附近公园',
] as const;

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantUiState {
  open: boolean;
  layout: AssistantSheetLayout;
  phase: AssistantPhase;
  draft: string;
  messages: AssistantMessage[];
  statusText: string | null;
  error: string | null;
  pendingRestoreText: string | null;
  candidates: TripChangeCandidate[];
  sourceChoices: TripChangeSourceChoice[];
  pendingReplace: TripChangePendingReplace | null;
  sessionHint: TripChangeFocus | null;
}

export function sheetLayoutForWidth(width: number): AssistantSheetLayout {
  return width <= ASK_SUIXING_BREAKPOINT_PX ? 'bottom' : 'side';
}

/** Prefer matchMedia over a one-shot innerWidth snapshot for layout. */
export function assistantLayoutForViewport(): AssistantSheetLayout {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'side';
  }
  return window.matchMedia(`(max-width: ${ASK_SUIXING_BREAKPOINT_PX}px)`).matches
    ? 'bottom'
    : 'side';
}

export function createAssistantUiState(layout: AssistantSheetLayout = 'side'): AssistantUiState {
  return {
    open: false,
    layout,
    phase: 'idle',
    draft: '',
    messages: [],
    statusText: null,
    error: null,
    pendingRestoreText: null,
    candidates: [],
    sourceChoices: [],
    pendingReplace: null,
    sessionHint: null,
  };
}

export function openAssistant(state: AssistantUiState): AssistantUiState {
  return { ...state, open: true };
}

export function closeAssistant(state: AssistantUiState): AssistantUiState {
  if (state.phase === 'interpreting' || state.phase === 'applying') {
    return state;
  }
  return {
    ...createAssistantUiState(state.layout),
    open: false,
  };
}

export function beginInterpret(state: AssistantUiState, text: string): AssistantUiState {
  const content = text.trim();
  if (
    content === ''
    || state.phase === 'interpreting'
    || state.phase === 'applying'
  ) {
    return state;
  }
  return {
    ...state,
    open: true,
    phase: 'interpreting',
    draft: '',
    error: null,
    pendingRestoreText: null,
    statusText: '正在理解你的调整…',
    candidates: [],
    sourceChoices: [],
    messages: [
      ...state.messages,
      { id: `user-${state.messages.length + 1}`, role: 'user', content },
    ],
  };
}

export function showClarification(
  state: AssistantUiState,
  summary: string,
  sourceChoices: TripChangeSourceChoice[] = [],
): AssistantUiState {
  return {
    ...state,
    open: true,
    phase: 'needs_clarification',
    statusText: null,
    error: null,
    draft: '',
    pendingRestoreText: null,
    candidates: [],
    sourceChoices,
    messages: [
      ...state.messages,
      { id: `assistant-${state.messages.length + 1}`, role: 'assistant', content: summary },
    ],
  };
}

export function showChoices(
  state: AssistantUiState,
  summary: string,
  candidates: TripChangeCandidate[],
  pendingReplace?: TripChangePendingReplace,
): AssistantUiState {
  return {
    ...state,
    open: true,
    phase: 'needs_choice',
    statusText: null,
    error: null,
    draft: '',
    pendingRestoreText: null,
    candidates,
    sourceChoices: [],
    pendingReplace: pendingReplace ?? null,
    sessionHint: pendingReplace
      ? {
        selectedDayNumber: pendingReplace.dayNumber,
        sourceTripPlaceId: pendingReplace.targetTripPlaceId,
      }
      : state.sessionHint,
    messages: [
      ...state.messages,
      { id: `assistant-${state.messages.length + 1}`, role: 'assistant', content: summary },
    ],
  };
}

export function beginApply(state: AssistantUiState): AssistantUiState {
  return {
    ...state,
    open: true,
    phase: 'applying',
    error: null,
    statusText: '正在调整这一天的行程…',
  };
}

export function markApplied(state: AssistantUiState): AssistantUiState {
  return {
    ...createAssistantUiState(state.layout),
    open: false,
    phase: 'applied',
  };
}

export function markFailed(state: AssistantUiState, message: string): AssistantUiState {
  const lastUser = [...state.messages].reverse().find((item) => item.role === 'user');
  return {
    ...state,
    open: true,
    phase: 'failed',
    statusText: '这次没有改行程。',
    error: message,
    draft: '',
    pendingRestoreText: lastUser?.content ?? null,
  };
}

export function restoreFailedDraft(state: AssistantUiState): AssistantUiState {
  if (!state.pendingRestoreText) {
    return state;
  }
  return {
    ...state,
    draft: state.pendingRestoreText,
    error: null,
  };
}

export function discardAssistantPlaceContext(state: AssistantUiState): AssistantUiState {
  return {
    ...state,
    sessionHint: null,
    candidates: [],
    sourceChoices: [],
    pendingReplace: null,
  };
}

export function canSubmitAssistant(state: AssistantUiState): boolean {
  return state.phase !== 'interpreting' && state.phase !== 'applying';
}
