import { ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * Aegis brand mark — maritime navy rounded square with a brass ShieldCheck,
 * the "AEGIS" wordmark (tracking-wide), and a thin brass underline bar.
 * Visual-only identity component; no logic.
 *
 * - `compact` (default): 40px navy tile + wordmark, for in-app chrome (nav, footer).
 * - `large`: bigger tile + larger wordmark, for the login splash.
 * - `wordmark={false}`: tile only.
 */
export function AegisLogo({
  size = 'compact',
  wordmark = true,
  className
}: {
  readonly size?: 'compact' | 'large';
  readonly wordmark?: boolean;
  readonly className?: string;
}) {
  const large = size === 'large';
  const tile = large ? 'h-14 w-14 rounded-2xl' : 'h-10 w-10 rounded-xl';
  const icon = large ? 30 : 22;
  return (
    <span className={clsx('inline-flex items-center', large ? 'gap-4' : 'gap-3', className)}>
      <span
        className={clsx(
          'inline-flex items-center justify-center bg-navy text-brass shadow-aegis-soft',
          tile
        )}
        aria-hidden="true"
      >
        <ShieldCheck size={icon} strokeWidth={1.75} />
      </span>
      {wordmark ? (
        <span className="inline-flex flex-col">
          <span
            className={clsx(
              'font-semibold leading-none text-navyDeep',
              large ? 'text-2xl tracking-[0.28em]' : 'text-lg tracking-[0.22em]'
            )}
          >
            AEGIS
          </span>
          <span
            className={clsx('mt-1.5 rounded-full bg-brass', large ? 'h-[2px] w-12' : 'h-[2px] w-8')}
            aria-hidden="true"
          />
        </span>
      ) : null}
    </span>
  );
}
