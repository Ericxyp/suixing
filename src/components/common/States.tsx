import type { ReactNode } from 'react';

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return <p className="state-message" aria-live="polite">{label}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="state-message">{children}</p>;
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="state-message state-message--error" role="alert">
      <p>{message}</p>
      <button className="text-button" type="button" onClick={onRetry}>重试</button>
    </div>
  );
}
