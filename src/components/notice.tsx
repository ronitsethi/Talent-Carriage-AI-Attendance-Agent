'use client';

import { useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * A flash message - "Contacted 3 people", "Mapping saved" - with a Dismiss.
 *
 * Most of these arrive in the URL, so dismissing one also takes its parameters
 * out of the address: otherwise a reload, or a link copied from the bar, would
 * announce the same thing again.
 */
export function Notice({ tone, clear = [], children }: { tone: 'ok' | 'err' | 'info'; clear?: string[]; children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    if (!clear.some((key) => params.has(key))) return;
    const next = new URLSearchParams(params.toString());
    for (const key of clear) next.delete(key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className={`notice ${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <div className="notice-body">{children}</div>
      <button type="button" className="notice-dismiss" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
