export function TripChangeMessage({
  role,
  content,
}: {
  role: 'user' | 'assistant';
  content: string;
}) {
  const label = role === 'user' ? '你' : '随行';
  return (
    <article className={`trip-change-message trip-change-message--${role}`}>
      <p className="trip-change-message__label">{label}</p>
      <p className="trip-change-message__body">{content}</p>
    </article>
  );
}
