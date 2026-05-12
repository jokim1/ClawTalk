type ThreadStartButtonProps = {
  onClick: () => void;
  label?: string;
  className?: string;
};

export function ThreadStartButton({
  onClick,
  label = 'Start new thread',
  className,
}: ThreadStartButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={className || 'thread-start-btn'}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13.5 3.5h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-2" />
        <path d="M7.5 12.5 14.8 5.2a1.4 1.4 0 1 1 2 2L9.5 14.5 6 15l.5-3.5Z" />
      </svg>
    </button>
  );
}
