import { FormEvent, KeyboardEvent } from 'react';

/**
 * Reusable composer for plan collection. Trip Workspace can later reuse this
 * as the “问随行” entry; structured TripChangeRequest handling stays elsewhere.
 */
export function PlanComposer({
  value,
  onChange,
  onSubmit,
  onFocus,
  disabled = false,
  error,
  sending = false,
  placeholder = '继续补充你的旅行想法…',
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  error?: string | null;
  sending?: boolean;
  placeholder?: string;
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
    <form className="plan-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="plan-composer-input">旅行想法</label>
      <textarea
        id="plan-composer-input"
        rows={3}
        value={value}
        disabled={disabled || sending}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      <div className="plan-composer__bar">
        {sending && <p className="plan-composer__status">正在整理旅行信息…</p>}
        {error && !sending && <p className="plan-composer__error" aria-live="polite">{error}</p>}
        <button type="submit" disabled={disabled || sending || !value.trim()}>
          发送
        </button>
      </div>
    </form>
  );
}
