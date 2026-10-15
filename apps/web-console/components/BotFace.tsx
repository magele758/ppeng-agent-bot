import type { ReactNode } from 'react';
import { botFaceIndex, type BotFaceIndex } from '@/lib/bot-face';
import './bot-face.css';

export interface BotFaceProps {
  name?: string | null;
  /** Spoken name. Omit on controls that already announce the bot name. */
  label?: string;
  testId?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function antenna(kind: 'one' | 'two' | 'side'): ReactNode {
  if (kind === 'one') {
    return (
      <>
        <line x1="12" y1="5.2" x2="12" y2="2.4" />
        <circle className="bot-face__fill" cx="12" cy="1.8" r="1.15" />
      </>
    );
  }
  if (kind === 'two') {
    return (
      <>
        <line x1="8.2" y1="6.2" x2="6.2" y2="2.6" />
        <line x1="15.8" y1="6.2" x2="17.8" y2="2.6" />
        <circle className="bot-face__fill" cx="5.8" cy="2" r="1" />
        <circle className="bot-face__fill" cx="18.2" cy="2" r="1" />
      </>
    );
  }
  return (
    <>
      <line x1="4.2" y1="10" x2="1.6" y2="8.2" />
      <circle className="bot-face__fill" cx="1.3" cy="7.7" r="1" />
    </>
  );
}

function namedFace(index: BotFaceIndex): ReactNode {
  switch (index) {
    case 0:
      return (
        <>
          {antenna('one')}
          <rect x="3.5" y="6" width="17" height="14" rx="4" />
          <circle className="bot-face__fill" cx="9" cy="12" r="1.25" />
          <circle className="bot-face__fill" cx="15" cy="12" r="1.25" />
          <path d="M8.2 15.6c1.1 1.5 2.4 2.1 3.8 2.1s2.7-.6 3.8-2.1" />
        </>
      );
    case 1:
      return (
        <>
          <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
          <rect className="bot-face__fill" x="7.2" y="10" width="2.4" height="2.4" />
          <rect className="bot-face__fill" x="14.4" y="10" width="2.4" height="2.4" />
          <line x1="8" y1="16.2" x2="16" y2="16.2" />
        </>
      );
    case 2:
      return (
        <>
          {antenna('one')}
          <rect x="3.5" y="6.2" width="17" height="13.6" rx="6" />
          <rect className="bot-face__fill" x="6.2" y="11" width="11.6" height="3.2" rx="1.4" />
        </>
      );
    case 3:
      return (
        <>
          {antenna('two')}
          <rect x="3.8" y="6.4" width="16.4" height="13.4" rx="3" />
          <path d="M7.4 12.4c.8-.9 1.8-.9 2.6 0M14 12.4c.8-.9 1.8-.9 2.6 0" />
          <circle cx="12" cy="16.2" r="1.15" />
        </>
      );
    case 4:
      return (
        <>
          {antenna('side')}
          <rect x="4.2" y="6" width="16" height="14" rx="4" />
          <circle cx="12.2" cy="12.2" r="2.5" />
          <circle className="bot-face__fill" cx="12.2" cy="12.2" r="1" />
          <line x1="10" y1="16.6" x2="14.4" y2="16.6" />
        </>
      );
    case 5:
      return (
        <>
          <rect x="3.5" y="6" width="17" height="14" rx="4" />
          <circle cx="9" cy="12" r="1.7" />
          <circle cx="15" cy="12" r="1.7" />
          <line x1="10.7" y1="12" x2="13.3" y2="12" />
          <path d="M8.4 16.2c1.2.9 2.3 1.2 3.6 1.2s2.4-.3 3.6-1.2" />
        </>
      );
    case 6:
      return (
        <>
          {antenna('one')}
          <rect x="3.6" y="6" width="16.8" height="14" rx="3" />
          <path d="M9 10.6v2.8M7.6 12h2.8M15 10.6v2.8M13.6 12h2.8" />
          <rect x="9.2" y="15.2" width="5.6" height="2.3" rx="0.4" />
        </>
      );
    case 7:
      return (
        <>
          {antenna('two')}
          <circle cx="12" cy="13.2" r="7" />
          <ellipse cx="9.3" cy="12.6" rx="1.15" ry="1.6" className="bot-face__fill" />
          <ellipse cx="14.7" cy="12.6" rx="1.15" ry="1.6" className="bot-face__fill" />
          <path d="M8.2 16.2 10 17.5 12 16.1l2 1.4 1.8-1.3" />
        </>
      );
    default: {
      const unreachable: never = index;
      return unreachable;
    }
  }
}

function emptyFace(): ReactNode {
  return (
    <>
      <rect x="4" y="6" width="16" height="14" rx="4" strokeDasharray="2.2 1.7" />
      <circle className="bot-face__fill" cx="9" cy="12" r="1" />
      <circle className="bot-face__fill" cx="15" cy="12" r="1" />
      <line x1="9" y1="16.4" x2="15" y2="16.4" />
    </>
  );
}

/** Original geometric robot face. Same trimmed name always draws the same face. */
export function BotFace({ name, label, testId, size = 'sm', className }: BotFaceProps) {
  const index = botFaceIndex(name);
  const faceId = index === null ? 'empty' : String(index);
  const classes = ['bot-face', size !== 'sm' ? `bot-face--${size}` : '', index === null ? 'bot-face--empty' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      data-testid={testId}
      data-bot-face={faceId}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="bot-face__stroke">{index === null ? emptyFace() : namedFace(index)}</g>
    </svg>
  );
}
