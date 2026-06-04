'use client';

import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { useEffect } from 'react';

export function ErrorFallback({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[400px] w-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-8 text-destructive" />
        </div>

        <div className="space-y-2">
          <h2 className='font-semibold text-2xl tracking-tight'>
            Something went wrong
          </h2>
          <p className='text-muted-foreground text-sm'>
            An unexpected error occurred. Please try again or contact support if
            the problem persists.
          </p>
        </div>

        {error.digest && (
          <div className='rounded-md bg-muted px-3 py-2 font-mono text-muted-foreground text-xs'>
            Error ID: {error.digest}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={reset} variant="default">
            Try again
          </Button>
          <Button
            onClick={() => {
              window.location.href = '/';
            }}
            variant="outline"
          >
            {' '}
            Go home
          </Button>
        </div>
      </div>
    </div>
  );
}
