import { FormEvent, KeyboardEvent, type Ref } from 'react';
import { ASK_SUIXING_EXAMPLES } from '../../services/trip-assistant-session';

export function TripChangeComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  sending = false,
  error,
  examples = ASK_SUIXING_EXAMPLES,
  placeholder = '例如：把今天下午的博物馆换成公园',
  inputRef,
  pendingRestore = false,
  onRestoreDraft,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  sending?: boolean;
  error?: string | null;
  examples?: readonly string[];
  placeholder?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  pendingRestore?: boolean;
  onRestoreDraft?: () => void;
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
        ref={inputRef}
        rows={3}
        value={value}
        disabled={disabled || sending}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {examples.length > 0 && (
        <div className="trip-change-chips" aria-label="示例说法">
          {examples.slice(0, 3).map((example) => (
            <button
              key={example}
              type="button"
              aria-pressed={value === example}
              disabled={disabled || sending}
              onClick={() => onChange(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
      {error && !sending && (
        <p className="trip-change-composer__error" role="alert">{error}</p>
      )}
      <div className="trip-change-composer__bar">
        {onRestoreDraft && pendingRestore && (
          <button
            className="trip-change-composer__restore"
            type="button"
            onClick={onRestoreDraft}
            disabled={disabled || sending}
          >
            重新编辑
          </button>
        )}
        <button type="submit" disabled={disabled || sending || !value.trim()}>
          {sending ? '正在调整…' : '发送'}
        </button>
      </div>
    </form>
  );
}
