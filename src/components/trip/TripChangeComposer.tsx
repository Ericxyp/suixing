import { FormEvent, KeyboardEvent } from 'react';
import { ASK_SUIXING_EXAMPLES } from '../../services/trip-assistant-session';

export function TripChangeComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  sending = false,
  error,
  examples = ASK_SUIXING_EXAMPLES,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  sending?: boolean;
  error?: string | null;
  examples?: readonly string[];
}) {
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (disabled || sending || !value.trim()) {
      return;
    }
    onSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="trip-change-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="trip-change-input">行程修改说明</label>
      <textarea
        id="trip-change-input"
        rows={3}
        value={value}
        disabled={disabled || sending}
        placeholder="第二天不要去长城，换成颐和园"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {examples.length > 0 && (
        <div className="trip-change-chips" aria-label="示例说法">
          {examples.slice(0, 3).map((example) => (
            <button
              key={example}
              type="button"
              disabled={disabled || sending}
              onClick={() => onChange(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
      <div className="trip-change-composer__bar">
        {error && !sending && <p className="trip-change-composer__error" aria-live="polite">{error}</p>}
        <button type="submit" disabled={disabled || sending || !value.trim()}>
          发送
        </button>
      </div>
    </form>
  );
}
