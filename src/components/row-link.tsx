'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A table row that opens its page when clicked anywhere on it.
 *
 * Clicks on the row's own controls - a tick box, a switch, a link - do what
 * those controls do and nothing more. The employee's name inside the row is
 * still a real link, so the row can be reached from the keyboard and opened in
 * a new tab.
 */
export function RowLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const router = useRouter();

  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as HTMLElement;
    // The gaps around a row's switches and tick box count as the control too: a
    // near miss on "Call" should not leave the page.
    if (target.closest('a, button, input, select, textarea, label, .switch-group, .row-control')) return;
    // Selecting text to copy a name is not a request to leave the page.
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank');
    else router.push(href);
  };

  return (
    <tr className={`clickable ${className ?? ''}`} onClick={open}>
      {children}
    </tr>
  );
}
