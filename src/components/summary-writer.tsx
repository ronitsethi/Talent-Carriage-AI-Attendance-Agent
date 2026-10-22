'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Has a summary written, once the page is already on screen.
 *
 * The model takes a second or two, and opening a case should not wait on it:
 * the page shows what it has, this asks for the summary, and the page is
 * refreshed with it when it arrives. Shown only when the summary is missing or
 * older than the conversation.
 */
export function SummaryWriter({ write, hasOne }: { write: () => Promise<boolean>; hasOne: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<'writing' | 'failed'>('writing');
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    write()
      .then((ok) => (ok ? router.refresh() : setState('failed')))
      .catch(() => setState('failed'));
  }, [write, router]);

  if (state === 'failed') {
    return <p className="hint">The summary could not be written just now. It will be tried again next time this page is opened.</p>;
  }
  return <p className="hint summary-writing">{hasOne ? 'Updating the summary with what has been said since…' : 'Writing the summary…'}</p>;
}
