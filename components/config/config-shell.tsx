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
    <div className="flex min-h-dvh flex-col bg-background pb-16 md:pb-0">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="flex flex-col gap-4 px-4 py-4 lg:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <div>
                <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
                  {sectionMeta.title}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {sectionMeta.description}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  validationPassed
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                }`}
              >
                {validationPassed ? 'Ready to save' : 'Fix validation issues'}
              </div>
              {saveReminderVisible && isDirty ? (
                <div className="rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300">
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

          <nav className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory scroll-px-4">
            {configSections.map((item) => {
              const href = `/config/${item.key}`;
              const isActive = pathname === href;

              return (
                <Link
                  key={item.key}
                  href={href}
                  className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {item.title}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-6">
        {isLoading ? (
          <div className="flex h-[60vh] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {runtimeIssues.length > 0 ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950">
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
                        <div className="text-xs text-amber-900/80">
                          Missing: {issue.missingEnvVars.join(', ')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid gap-6 xl:items-start xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.95fr)]">
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
    </div>
  );
}
