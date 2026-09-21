import { useEffect, useRef, useState } from 'react';
import { ConversationMessage } from './ConversationMessage';
import { PlanComposer } from './PlanComposer';
import { TripStyleEditor } from './TripStyleEditor';
import { TripStyleSummaryCard } from './TripStyleSummaryCard';
import type { TripRequirementDraft } from '../../domain/trip/ai';
import type { PlanConversationState } from '../../services/plan-conversation-service';
import { PLAN_GENERATING_MESSAGE, PLAN_GENERATION_FAILED_MESSAGE } from '../../services/plan-conversation-service';
import type { PlanGenerationStatus } from '../../services/plan-generation';
import { PLAN_CREATING_PLACEHOLDER } from '../../services/plan-generation';
import { PLAN_EMPTY_GUIDE, PLAN_EXTRACTING_STATUS } from '../../services/plan-conversation-display';
import { subscribeKeyboardInset } from '../../services/mobile-viewport';
import { buildTripStyleViewV1 } from '../../services/trip-style-display';

export function PlanConversation({
  state,
  composerValue,
  onComposerChange,
  onSubmit,
  extracting,
  generating,
  generationStatus,
  error,
  showRetry,
  onRetry,
  onTripStyleSave,
}: {
  state: PlanConversationState;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSubmit: () => void;
  extracting: boolean;
  generating: boolean;
  generationStatus: PlanGenerationStatus;
  error: string | null;
  showRetry: boolean;
  onRetry: () => void;
  onTripStyleSave: (draft: TripRequirementDraft) => void;
}) {
  const [editingStyle, setEditingStyle] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const stickToLatestRef = useRef(false);
  const empty = state.messages.length === 0 && !extracting;
  const visibleMessages = generationStatus === 'failed'
    ? state.messages.map((message) => (
      message.role === 'assistant' && message.content === PLAN_GENERATING_MESSAGE
        ? { ...message, content: PLAN_GENERATION_FAILED_MESSAGE }
        : message
    ))
    : state.messages;
  const alreadyHasGeneratingMessage = visibleMessages.some(
    (message) => message.content === PLAN_GENERATING_MESSAGE,
  );
  const styleView = buildTripStyleViewV1(state.draft);

  useEffect(() => subscribeKeyboardInset().disconnect, []);

  useEffect(() => {
    if (!stickToLatestRef.current) {
      return;
    }
    stickToLatestRef.current = false;
    const stream = streamRef.current;
    if (!stream) {
      return;
    }
    stream.scrollTop = stream.scrollHeight;
  }, [visibleMessages.length, extracting, generating, generationStatus]);

  function closeStyleEditor() {
    setEditingStyle(false);
    window.requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  function handleSubmit() {
    stickToLatestRef.current = true;
    onSubmit();
  }

  function handleComposerFocus() {
    stickToLatestRef.current = true;
    window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (stream) {
        stream.scrollTop = stream.scrollHeight;
      }
    });
  }

  return (
    <section className="plan-conversation" aria-label="规划对话">
      <div className="plan-conversation__stream" ref={streamRef}>
        {empty && (
          <p className="plan-conversation__empty">{PLAN_EMPTY_GUIDE}</p>
        )}
        {visibleMessages.map((message) => (
          <ConversationMessage key={message.id} message={message} />
        ))}
        {extracting && (
          <p className="plan-conversation__status" aria-live="polite">{PLAN_EXTRACTING_STATUS}</p>
        )}
        {generating && !alreadyHasGeneratingMessage && (
          <p className="plan-conversation__status" aria-live="polite">{PLAN_GENERATING_MESSAGE}</p>
        )}
      </div>
      <div className="plan-conversation__dock">
        <TripStyleSummaryCard
          view={styleView}
          locked={generating}
          editButtonRef={editButtonRef}
          onEdit={() => setEditingStyle(true)}
        />
        {editingStyle && (
          <TripStyleEditor
            draft={state.draft}
            onSave={(next) => {
              onTripStyleSave(next);
              closeStyleEditor();
            }}
            onCancel={closeStyleEditor}
          />
        )}
        {showRetry && generationStatus !== 'generating' && (
          <div className="plan-conversation__error-card" role="alert">
            {error && <p>{error}</p>}
            <button className="plan-conversation__retry" type="button" onClick={onRetry}>
              重试生成
            </button>
          </div>
        )}
        <PlanComposer
          value={composerValue}
          onChange={onComposerChange}
          onSubmit={handleSubmit}
          onFocus={handleComposerFocus}
          sending={extracting}
          disabled={generating}
          error={generationStatus === 'failed' ? null : error}
          placeholder={generating ? PLAN_CREATING_PLACEHOLDER : '继续补充你的旅行想法…'}
        />
      </div>
    </section>
  );
}
