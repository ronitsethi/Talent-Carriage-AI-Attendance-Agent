'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Refreshes the page while a document is still being read.
 *
 * Reading happens in the background, so the row that says "Reading…" is a
 * server-rendered snapshot of a moment that has already passed. Without this
 * nothing changes until somebody reloads by hand - and a page that is quietly
 * out of date looks exactly like one that is stuck, which is how a document
 * that finished in ninety seconds gets reported as broken.
 *
 * It asks the server for the page again rather than polling an endpoint, so
 * there is nothing extra to build and the row updates in place.
 */
export function RefreshWhileReading({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}
