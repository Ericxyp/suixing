export type AssistantSheetLayout = 'side' | 'bottom';
export type AssistantPhase =
  | 'idle'
  | 'interpreting'
  | 'needs_clarification'
  | 'applying'
  | 'applied'
  | 'failed';

export const ASK_SUIXING_BREAKPOINT_PX = 880;
export const ASK_SUIXING_EXAMPLES = [
  '第二天不要去长城，换成颐和园',
  '改成附近的博物馆',
  '换成一家咖啡馆',
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
}

export function sheetLayoutForWidth(width: number): AssistantSheetLayout {
  return width <= ASK_SUIXING_BREAKPOINT_PX ? 'bottom' : 'side';
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
  };
}

export function openAssistant(state: AssistantUiState): AssistantUiState {
  return { ...state, open: true };
}

export function closeAssistant(state: AssistantUiState): AssistantUiState {
  if (state.phase === 'interpreting' || state.phase === 'applying') {
    return state;
  }
  return { ...state, open: false };
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
    statusText: '正在理解你的调整…',
    messages: [
      ...state.messages,
      { id: `user-${state.messages.length + 1}`, role: 'user', content },
    ],
  };
}

export function showClarification(state: AssistantUiState, summary: string): AssistantUiState {
  const lastUser = [...state.messages].reverse().find((item) => item.role === 'user');
  return {
    ...state,
    open: true,
    phase: 'needs_clarification',
    statusText: null,
    error: null,
    draft: state.draft.trim() !== '' ? state.draft : lastUser?.content ?? '',
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
    ...state,
    open: false,
    phase: 'applied',
    statusText: null,
    error: null,
    draft: '',
  };
}

export function markFailed(state: AssistantUiState, message: string): AssistantUiState {
  const lastUser = [...state.messages].reverse().find((item) => item.role === 'user');
  return {
    ...state,
    open: true,
    phase: 'failed',
    statusText: null,
    error: message,
    draft: state.draft.trim() !== '' ? state.draft : lastUser?.content ?? '',
  };
}

export function canSubmitAssistant(state: AssistantUiState): boolean {
  return state.phase !== 'interpreting' && state.phase !== 'applying';
}
