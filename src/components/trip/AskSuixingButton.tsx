export function AskSuixingButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="ask-suixing-entry"
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      <svg className="ask-suixing-entry__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.2 3.2A.8.8 0 0 1 5.5 17.6V15A2.5 2.5 0 0 1 5 12.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      问随行
    </button>
  );
}
