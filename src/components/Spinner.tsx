type Size = 'sm' | 'md' | 'lg';

interface Props {
  size?: Size;
  className?: string;
}

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
};

export function Spinner({ size = 'md', className = '' }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={`${SIZE_CLASS[size]} animate-spin ${className}`.trim()}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3" fill="none" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
