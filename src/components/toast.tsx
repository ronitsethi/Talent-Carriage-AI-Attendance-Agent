'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Good news, said once and then gone: "Imported 412 days", "Mapping saved".
 *
 * It sits in the corner and leaves by itself, because nobody needs to file a
 * receipt for work that went as expected - and a banner that waits to be
 * dismissed is read once and then clicked past for ever after. Problems keep
 * the `Notice` banner instead: those have to be read, and often acted on.
 */

const LIFETIME_MS = 6000;
const FADE_MS = 300;

/** The one stack every toast goes into, so two at once sit above each other. */
function useToastStack(): HTMLElement | null {
  const [stack, setStack] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let node = document.querySelector<HTMLElement>('.toast-stack');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast-stack';
      // Announced to a screen reader as it appears, not as an interruption.
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    setStack(node);
  }, []);

  return stack;
}

export function Toast({
  tone = 'ok',
  clear = [],
  children,
}: {
  tone?: 'ok' | 'info';
  /** Query parameters this message came in on, taken out of the address as it goes. */
  clear?: string[];
  children: ReactNode;
}) {
  const stack = useToastStack();
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  // Reading it keeps it: the clock stops while the pointer is on it.
  const [held, setHeld] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const forget = useCallback(() => {
    if (!clear.some((key) => params.has(key))) return;
    const next = new URLSearchParams(params.toString());
    for (const key of clear) next.delete(key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [clear, params, pathname, router]);

  useEffect(() => {
    if (gone || leaving || held) return;
    const timer = setTimeout(() => setLeaving(true), LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [gone, leaving, held]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setGone(true);
      // Only once it has gone: dropping the parameters re-renders the page,
      // which would otherwise take the toast away mid-sentence.
      forget();
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving, forget]);

  if (gone || !stack) return null;

  return createPortal(
    <div
      className={`toast ${tone} ${leaving ? 'leaving' : ''}`}
      role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div className="toast-body">{children}</div>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setLeaving(true)}>
        ×
      </button>
    </div>,
    stack,
  );
}
