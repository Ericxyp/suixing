import { ConversationMessage } from './ConversationMessage';
import { PlanComposer } from './PlanComposer';
import type { PlanConversationState } from '../../services/plan-conversation-service';
import { PLAN_GENERATING_MESSAGE, PLAN_GENERATION_FAILED_MESSAGE } from '../../services/plan-conversation-service';
import type { PlanGenerationStatus } from '../../services/plan-generation';
import { PLAN_CREATING_PLACEHOLDER } from '../../services/plan-generation';

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
}) {
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

  return (
    <section className="plan-conversation" aria-label="规划对话">
      <div className="plan-conversation__stream">
        {empty && (
          <p className="plan-conversation__empty">说说你想去哪，随行会帮你一点点补齐旅行信息。</p>
        )}
        {visibleMessages.map((message) => (
          <ConversationMessage key={message.id} message={message} />
        ))}
        {generating && !alreadyHasGeneratingMessage && (
          <p className="plan-conversation__status" aria-live="polite">{PLAN_GENERATING_MESSAGE}</p>
        )}
      </div>
      <PlanComposer
        value={composerValue}
        onChange={onComposerChange}
        onSubmit={onSubmit}
        sending={extracting}
        disabled={generating}
        error={error}
        placeholder={generating ? PLAN_CREATING_PLACEHOLDER : '继续补充你的旅行想法…'}
      />
      {showRetry && generationStatus !== 'generating' && (
        <button className="text-button plan-conversation__retry" type="button" onClick={onRetry}>
          重试生成
        </button>
      )}
    </section>
  );
}
