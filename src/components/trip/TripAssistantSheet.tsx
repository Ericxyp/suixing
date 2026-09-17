import { TripChangeComposer } from './TripChangeComposer';
import { TripChangeMessage } from './TripChangeMessage';
import {
  canSubmitAssistant,
  type AssistantUiState,
} from '../../services/trip-assistant-session';

export function TripAssistantSheet({
  state,
  onClose,
  onDraftChange,
  onSubmit,
}: {
  state: AssistantUiState;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  if (!state.open) {
    return null;
  }
  const busy = !canSubmitAssistant(state);
  return (
    <div className={`ask-suixing-layer ask-suixing-layer--${state.layout}`}>
      <button
        className="ask-suixing-dismiss"
        type="button"
        aria-label="关闭问随行"
        disabled={busy}
        onClick={onClose}
      />
      <aside
        className={`ask-suixing-sheet ask-suixing-sheet--${state.layout}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="ask-suixing-title"
      >
        <header className="ask-suixing-sheet__header">
          <div>
            <p className="eyebrow">修改行程</p>
            <h2 id="ask-suixing-title">问随行</h2>
          </div>
          <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        </header>
        <div className="ask-suixing-sheet__stream">
          {state.messages.length === 0 && (
            <p className="ask-suixing-sheet__empty">直接说想换掉哪一天的哪个地点。</p>
          )}
          {state.messages.map((message) => (
            <TripChangeMessage key={message.id} role={message.role} content={message.content} />
          ))}
          {state.statusText && (
            <p className="ask-suixing-sheet__status" role="status">{state.statusText}</p>
          )}
        </div>
        <TripChangeComposer
          value={state.draft}
          onChange={onDraftChange}
          onSubmit={onSubmit}
          disabled={busy}
          sending={busy}
          error={state.error}
        />
      </aside>
    </div>
  );
}
