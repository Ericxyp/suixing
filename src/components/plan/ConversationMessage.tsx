import type { PlanMessage } from '../../services/plan-conversation-service';

export function ConversationMessage({ message }: { message: PlanMessage }) {
  const label = message.role === 'user' ? '你' : '随行';
  return (
    <article className={`plan-message plan-message--${message.role}`}>
      <p className="plan-message__label">{label}</p>
      <p className="plan-message__body">{message.content}</p>
    </article>
  );
}
