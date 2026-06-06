'use client';

import { Loader2, Save } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  type ConfigSectionKey,
  configSections,
  getConfigSectionMeta,
} from '@/components/config/config-sections';
import { RawJsonEditor } from '@/components/config/raw-json-editor';
import { Button } from '@/components/ui/button';
import { useConfigDraft } from '@/hooks/use-config-draft';

export function ConfigShell({
  children,
  section,
}: {
  children: React.ReactNode;
  section: ConfigSectionKey;
}) {
  const pathname = usePathname();
  const {
    isDirty,
    isLoading,
    isSaving,
    runtimeHealth,
    saveConfig,
    saveReminderVisible,
    validationPassed,
  } = useConfigDraft();
  const sectionMeta = getConfigSectionMeta(section);
  const runtimeIssues =
    runtimeHealth?.checks.filter((check) => check.status !== 'ready') ?? [];

  return (
    <div className="flex min-h-dvh flex-col bg-background pb-20 md:pb-0">
      <header className="sticky top-0 z-20 border-b bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="flex flex-col gap-4 px-14 py-4 md:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <div>
                <h1 className="font-semibold text-2xl tracking-tight md:text-3xl">
                  {sectionMeta.title}
                </h1>
                <p className="max-w-2xl text-muted-foreground text-sm">
                  {sectionMeta.description}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`rounded-full px-3 py-1 font-medium text-xs ${
                  validationPassed
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                }`}
              >
                {validationPassed ? 'Ready to save' : 'Fix validation issues'}
              </div>
              {saveReminderVisible && isDirty ? (
                <div className="rounded-full bg-sky-500/10 px-3 py-1 font-medium text-sky-700 text-xs dark:text-sky-300">
                  Unsaved changes
                </div>
              ) : null}
              <Button
                size="sm"
                disabled={
                  !validationPassed || isLoading || isSaving || !isDirty
                }
                onClick={saveConfig}
              >
                {isSaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save config
              </Button>
            </div>
          </div>

          <nav className="flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {configSections.map((item) => {
              const href = `/config/${item.key}`;
              const isActive = pathname === href;

              return (
                <Button
                  key={item.key}
                  asChild
                  size="sm"
                  variant={isActive ? 'default' : 'secondary'}
                  className="shrink-0"
                >
                  <Link href={href} prefetch={false}>
                    {item.title}
                  </Link>
                </Button>
              );
            })}
          </nav>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-8 lg:py-6">
        {isLoading ? (
          <div className="flex h-[60vh] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mx-auto max-w-7xl space-y-6">
            {runtimeIssues.length > 0 ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-amber-950 text-sm">
                <div className="font-medium">
                  Runtime prerequisites need attention
                </div>
                <div className="mt-1 text-amber-900/80">
                  Some server features will run in a degraded state until the
                  missing environment variables are configured.
                </div>
                <div className="mt-3 space-y-2">
                  {runtimeIssues.map((issue) => (
                    <div key={issue.key}>
                      <div className="font-medium">
                        {issue.label}: {issue.message}
                      </div>
                      {issue.missingEnvVars.length > 0 ? (
                        <div className="text-amber-900/80 text-xs">
                          Missing: {issue.missingEnvVars.join(', ')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.95fr)] xl:items-start">
              <div className="min-w-0">{children}</div>
              <div className="min-w-0 xl:self-start">
                <div className="xl:sticky xl:top-0 xl:self-start">
                  <RawJsonEditor />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <Button
        aria-label="Save config"
        className="fixed right-5 bottom-5 z-30 size-14 rounded-full shadow-lg md:right-8 md:bottom-8"
        disabled={!validationPassed || isLoading || isSaving || !isDirty}
        onClick={saveConfig}
      >
        {isSaving ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <Save className="size-5" />
        )}
      </Button>
    </div>
  );
}
