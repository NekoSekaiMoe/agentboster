'use client';

import { useEffect, useState } from 'react';

import { getDraftSkillCountAction } from '@/app/(skill)/actions';
import { usePathname } from 'next/navigation';

/**
 * Sidebar / mobile-nav badge showing the count of draft skills awaiting
 * review. Renders nothing when the count is 0 (no visual noise when the
 * queue is empty).
 *
 * Why this is a separate client component: the nav data structures in
 * app-sidebar / mobile-nav are static module-level arrays. Injecting a
 * server-fetched count into them would force the whole sidebar client
 * component to become async. Instead, the sidebar stays static and this
 * tiny leaf component fetches one integer and renders a dot.
 *
 * Refresh strategy: poll on mount, on route change, and every 60s. The
 * 60s cadence is a compromise — drafts are produced at most once per
 * qualifying conversation (not real-time chatter), so a minute of
 * latency is invisible in practice while keeping the request volume
 * trivial. The route-change hook gives an instant refresh when the user
 * navigates to /skills after a conversation that produced a draft.
 */
export function SkillDraftBadge() {
  const [count, setCount] = useState(0);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is an intentional refresh trigger — we re-fetch on navigation so the badge updates when the user lands on /skills after a draft-producing conversation. It's not read inside the effect.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const next = await getDraftSkillCountAction();
      if (!cancelled) setCount(next);
    }
    void refresh();

    // Poll every 60s. setInterval (not setTimeout recursion) because the
    // cadence is fixed and we don't need to wait for the previous fetch.
    const interval = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pathname]); // re-fetch on navigation

  if (count <= 0) return null;

  return (
    <span
      role="status"
      aria-label={`${count} skill draft${count === 1 ? '' : 's'} pending review`}
      // biome-ignore lint/nursery/useSortedClasses: intentional order for visual hierarchy
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground"
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}
