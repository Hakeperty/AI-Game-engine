import type { CSSProperties } from 'react';
import { PATHS } from './iconPaths.ts';

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  fill = false,
  className,
  style,
  title,
}: {
  name: IconName | string;
  size?: number;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const d = PATHS[name] ?? PATHS.file!;
  const filled = fill || name === 'play' || name === 'pause' || name === 'stop';
  const props = {
    className: className ? `icon ${className}` : 'icon',
    style,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    strokeWidth: filled ? 0 : 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (title) {
    return (
      <svg {...props} role="img" aria-label={title}>
        <title>{title}</title>
        <path d={d} />
      </svg>
    );
  }
  // Decorative: the surrounding button or label carries the meaning.
  return (
    <svg {...props} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
