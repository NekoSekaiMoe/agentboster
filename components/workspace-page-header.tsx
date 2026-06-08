'use client';

import { MessageSquare, Plus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

export function WorkspacePageHeader({
  actions,
  description,
  title,
}: {
  actions?: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 pl-16 backdrop-blur md:pl-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-base md:text-lg">
            {title}
          </h1>
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {actions}
          <Button size="sm" variant="outline" asChild>
            <Link href="/">
              <MessageSquare className="mr-1 size-4" />
              Chat
            </Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/">
              <Plus className="mr-1 size-4" />
              New chat
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
