'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftRight,
  BookOpen,
  ClipboardCheck,
  LayoutDashboard,
  Menu,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The parts of the shell that need the browser: which page is lit in the nav,
 * and the drawer the sidebar becomes on a phone. Everything inside them is
 * still rendered on the server and handed in.
 */

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/cases', label: 'Follow-up cases', icon: ClipboardCheck },
  { href: '/mapping', label: 'Mapping & import', icon: ArrowLeftRight },
  { href: '/knowledge', label: 'Guidelines', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal },
];

const ADMIN = { href: '/admin', label: 'All customers', icon: Users };

export function Nav({ openCases, showAdmin }: { openCases: number; showAdmin: boolean }) {
  const pathname = usePathname();
  const items = showAdmin ? [...NAV, ADMIN] : NAV;

  return (
    <nav className="nav" aria-label="Main">
      {items.map(({ href, label, icon: Icon }) => {
        // A case is part of Follow-up cases, so /cases/abc lights that item.
        const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
            <Icon size={21} strokeWidth={1.8} aria-hidden />
            <span>{label}</span>
            {href === '/cases' && openCases ? (
              <span className="nav-badge" title={`${openCases} open ${openCases === 1 ? 'case' : 'cases'}`}>
                {openCases}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function Shell({ sidebar, statusBar, children }: { sidebar: ReactNode; statusBar: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  // Remembers the page it was opened on, so following a link closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenOn(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className={`shell${open ? ' drawer-open' : ''}`}>
      <aside className="sidebar" id="sidebar">
        {sidebar}
      </aside>
      <div className="scrim" aria-hidden onClick={() => setOpenOn(null)} />
      <div className="main">
        <header className="statusbar">
          <button
            type="button"
            className="menu-btn"
            aria-controls="sidebar"
            aria-expanded={open}
            onClick={() => setOpenOn(open ? null : pathname)}
          >
            <Menu size={20} strokeWidth={1.8} aria-hidden />
            Menu
          </button>
          {statusBar}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
