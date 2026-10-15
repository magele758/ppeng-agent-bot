import type { SectionId } from '@/lib/nav';

const common = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

export function SectionIcon({ id }: { id: SectionId }) {
  switch (id) {
    case 'bot':
      return (
        <svg {...common}>
          <rect x="6" y="8" width="12" height="10" rx="3" />
          <path d="M12 4v4M9 13h.01M15 13h.01M9 4h6" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12Z" />
        </svg>
      );
    case 'agents':
      return (
        <svg {...common}>
          <rect x="5" y="8" width="14" height="11" rx="3" />
          <path d="M12 4v4M9 13h.01M15 13h.01" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...common}>
          <path d="m4 12 4 4 8-9M14 18h6" />
        </svg>
      );
    case 'knowledge':
      return (
        <svg {...common}>
          <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5ZM8 7h7" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        </svg>
      );
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}
