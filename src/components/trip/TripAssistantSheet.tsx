import { useEffect, useRef } from 'react';
import type { Trip, TripDay } from '../../domain/trip/types';
import {
  ASK_SUIXING_CAPABILITY,
  ASK_SUIXING_HINT,
  askSuixingDayLabel,
  askSuixingDaySummary,
} from '../../services/ask-suixing-display';
import { lockBackgroundScroll } from '../../services/mobile-viewport';
import {
  canSubmitAssistant,
  type AssistantUiState,
} from '../../services/trip-assistant-session';
import type { TripChangeCandidate, TripChangeSourceChoice } from '../../services/bff-trip-change-service';
import { TripChangeComposer } from './TripChangeComposer';
import { TripChangeMessage } from './TripChangeMessage';

export function TripAssistantSheet({
  state,
  trip,
  day,
  examples,
  placeholder,
  onClose,
  onDraftChange,
  onSubmit,
  onRestoreDraft,
  onSelectCandidate,
  onSelectSource,
}: {
  state: AssistantUiState;
  trip: Trip;
  day?: TripDay;
  examples: readonly string[];
  placeholder: string;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onRestoreDraft?: () => void;
  onSelectCandidate?: (candidate: TripChangeCandidate) => void;
  onSelectSource?: (choice: TripChangeSourceChoice) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = !canSubmitAssistant(state);

  useEffect(() => {
    if (!state.open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && canSubmitAssistant(state)) {
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, state]);

  useEffect(() => {
    if (!state.open) {
      return;
    }
    const lock = lockBackgroundScroll();
    inputRef.current?.focus();
    return () => lock.unlock();
  }, [state.open]);

  if (!state.open) {
    return null;
  }

  const summary = day ? askSuixingDaySummary(trip, day) : '';

  return (
    <div className="ask-suixing-layer">
      <button
        className="ask-suixing-dismiss"
        type="button"
        aria-label="关闭问随行"
        disabled={busy}
        onClick={onClose}
      />
      <aside
        className="ask-suixing-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-suixing-title"
      >
        <header className="ask-suixing-sheet__header">
          <div>
            <p className="ask-suixing-sheet__eyebrow">调整行程</p>
            <h2 id="ask-suixing-title">问随行</h2>
          </div>
          <button
            className="ask-suixing-sheet__close"
            type="button"
            aria-label="关闭问随行"
            disabled={busy}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        </header>
        {day && (
          <div className="ask-suixing-context">
            <p className="ask-suixing-context__day">{askSuixingDayLabel(day)}</p>
            {summary && <p className="ask-suixing-context__summary">{summary}</p>}
          </div>
        )}
        <div className="ask-suixing-sheet__stream">
          {state.messages.length === 0 && (
            <div className="ask-suixing-sheet__empty">
              <p>{ASK_SUIXING_HINT}</p>
              <p>{ASK_SUIXING_CAPABILITY}</p>
            </div>
          )}
          {state.messages.map((message) => (
            <TripChangeMessage key={message.id} role={message.role} content={message.content} />
          ))}
          {state.sourceChoices.length > 0 && (
            <div className="ask-source-choices" aria-label="选择要替换的地点">
              {state.sourceChoices.map((choice) => (
                <button
                  key={choice.tripPlaceId}
                  type="button"
                  disabled={busy}
                  onClick={() => onSelectSource?.(choice)}
                >
                  {choice.placeName}
                </button>
              ))}
            </div>
          )}
          {state.candidates.length > 0 && (
            <div className="ask-choice-list">
              {state.candidates.map((candidate) => (
                <article className="ask-choice" key={candidate.placeId}>
                  <div>
                    <h3>{candidate.name}</h3>
                    <p>{candidate.categoryLabel}</p>
                    <p>{candidate.relation}</p>
                  </div>
                  {state.pendingReplace && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onSelectCandidate?.(candidate)}
                    >
                      替换为这里
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
          {state.statusText && (
            <p className="ask-suixing-sheet__status" role="status">{state.statusText}</p>
          )}
        </div>
        <TripChangeComposer
          inputRef={inputRef}
          value={state.draft}
          onChange={onDraftChange}
          onSubmit={onSubmit}
          disabled={busy}
          sending={busy}
          error={state.error}
          examples={examples}
          placeholder={placeholder}
          pendingRestore={Boolean(state.pendingRestoreText)}
          onRestoreDraft={onRestoreDraft}
        />
      </aside>
    </div>
  );
}
