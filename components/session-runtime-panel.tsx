'use client';

import { motion } from 'framer-motion';
import { Loader2, RefreshCw, Square, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  controlSessionRuntimeAction,
  getSessionRuntimeAction,
} from '@/app/(chat)/actions';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SessionRuntimeResponse } from '@/lib/core/sandbox/session-runtime';

type RuntimeStatusTone =
  | NonNullable<SessionRuntimeResponse['workflow']['status']>
  | SessionRuntimeResponse['workflow']['phase']
  | SessionRuntimeResponse['sandbox']['status'];

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusTone(status: RuntimeStatusTone | null): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'bg-emerald-500';
    case 'error':
      return 'bg-rose-500';
    case 'completed':
      return 'bg-sky-500';
    case 'cancelled':
    case 'stopped':
    case 'idle':
    case 'missing':
      return 'bg-zinc-400';
    case 'stopping':
      return 'bg-amber-500';
    default:
      return 'bg-amber-500';
  }
}

export function SessionRuntimePanel({
  chatId,
  enabled = true,
  latestRuntimeEvent,
  resumePollingKey = 0,
  onRuntimeLoaded,
  onWorkflowCancel,
}: {
  chatId: string;
  enabled?: boolean;
  latestRuntimeEvent?: { type?: string } | null;
  resumePollingKey?: number;
  onRuntimeLoaded?: (runtime: SessionRuntimeResponse) => void;
  onWorkflowCancel?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<SessionRuntimeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollingLockedByCompletion, setPollingLockedByCompletion] =
    useState(false);
  const [submitting, setSubmitting] = useState<'workflow' | 'sandbox' | null>(
    null,
  );

  const applyRuntime = useCallback(
    (nextRuntime: SessionRuntimeResponse) => {
      setRuntime(nextRuntime);
      onRuntimeLoaded?.(nextRuntime);

      if (nextRuntime.workflow.status === 'completed') {
        setPollingLockedByCompletion(true);
        return;
      }

      if (
        nextRuntime.workflow.phase === 'idle' ||
        nextRuntime.workflow.status === null ||
        nextRuntime.workflow.status === 'pending' ||
        nextRuntime.workflow.status === 'running'
      ) {
        setPollingLockedByCompletion(false);
      }
    },
    [onRuntimeLoaded],
  );

  const fetchRuntime = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setLoading(true);
    try {
      const nextRuntime = await getSessionRuntimeAction(chatId);
      if (!nextRuntime) {
        applyRuntime({
          sessionId: chatId,
          environment: null,
          workflow: {
            runId: null,
            status: null,
            phase: 'idle',
            canCancel: false,
            startedAt: null,
            stoppedAt: null,
            durationMs: 0,
            lastError: null,
          },
          approval: {
            toolCallId: null,
            toolName: null,
            status: null,
            comment: null,
            requestedAt: null,
            respondedAt: null,
          },
          sandbox: {
            sandboxId: null,
            status: 'idle',
            canStop: false,
            startedAt: null,
            lastActiveAt: null,
            stoppedAt: null,
            durationMs: 0,
            timeoutMs: null,
            publicPorts: [],
            lastCommand: null,
            lastExitCode: null,
            lastError: null,
          },
        });
        return;
      }
      applyRuntime(nextRuntime);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to load runtime.',
      );
    } finally {
      setLoading(false);
    }
  }, [applyRuntime, chatId, enabled]);

  const shouldPoll = useMemo(() => {
    if (!enabled || !runtime || pollingLockedByCompletion) {
      return false;
    }

    return (
      runtime.workflow.status === 'running' ||
      runtime.workflow.status === 'pending' ||
      runtime.sandbox.status === 'running' ||
      runtime.sandbox.status === 'pending' ||
      runtime.sandbox.status === 'stopping'
    );
  }, [enabled, pollingLockedByCompletion, runtime]);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setRuntime(null);
      setLoading(false);
      return;
    }

    void fetchRuntime();
  }, [enabled, fetchRuntime]);

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchRuntime();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [fetchRuntime, shouldPoll]);

  useEffect(() => {
    if (enabled && latestRuntimeEvent?.type) {
      if (pollingLockedByCompletion) {
        return;
      }
      void fetchRuntime();
    }
  }, [enabled, fetchRuntime, latestRuntimeEvent, pollingLockedByCompletion]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setPollingLockedByCompletion(false);

    void resumePollingKey;
    void fetchRuntime();
  }, [enabled, fetchRuntime, resumePollingKey]);

  const workflowLabel = useMemo(() => {
    if (!runtime) {
      return 'idle';
    }
    return runtime.workflow.status ?? runtime.workflow.phase;
  }, [runtime]);

  const sandboxLabel = useMemo(() => {
    if (!runtime) {
      return 'idle';
    }
    return runtime.sandbox.status;
  }, [runtime]);

  const runControl = useCallback(
    async (target: 'workflow' | 'sandbox', action: 'cancel' | 'stop') => {
      setSubmitting(target);
      try {
        if (target === 'workflow' && onWorkflowCancel) {
          await onWorkflowCancel();
        } else {
          const payload = await controlSessionRuntimeAction({
            sessionId: chatId,
            target,
            action,
          });

          if (payload.runtime) {
            applyRuntime(payload.runtime);
          } else {
            await fetchRuntime();
          }
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Control action failed.',
        );
      } finally {
        setSubmitting(null);
      }
    },
    [applyRuntime, chatId, fetchRuntime, onWorkflowCancel],
  );

  if (!enabled) {
    return null;
  }

  return (
    <motion.div
      drag
      dragMomentum={false}
      initial={{ x: 0, y: 0 }}
      className="fixed bottom-3 right-2 z-50 max-w-[calc(100vw-1rem)] sm:bottom-5 sm:right-5"
    >
      <div className="flex flex-col items-end gap-3">
        {open && (
          <Card className="flex max-h-[70dvh] w-[calc(100vw-1rem)] max-w-[320px] flex-col border-zinc-800/10 bg-background/95 shadow-2xl backdrop-blur">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>Session Runtime</span>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Refresh runtime"
                    title="Refresh runtime"
                    disabled={loading || submitting !== null}
                    onClick={() => void fetchRuntime()}
                  >
                    <RefreshCw
                      className={loading ? 'animate-spin' : undefined}
                    />
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto break-words text-xs">
              <div className="space-y-1">
                <div className="font-medium text-sm">Session</div>
                <div className="break-all text-muted-foreground">{chatId}</div>
              </div>

              {runtime?.environment ? (
                <div className="space-y-2">
                  <div className="font-medium text-sm">Environment</div>
                  <div>
                    Status:{' '}
                    {runtime.environment.status === 'ready'
                      ? 'ready'
                      : 'degraded'}
                  </div>
                  {runtime.environment.checks
                    .filter((check) => check.status !== 'ready')
                    .map((check) => (
                      <div
                        key={check.key}
                        className="rounded-lg border px-2 py-2"
                      >
                        <div className="font-medium">
                          {check.label}: {check.status}
                        </div>
                        <div className="text-muted-foreground">
                          {check.message}
                        </div>
                        {check.missingEnvVars.length > 0 ? (
                          <div className="text-amber-700">
                            Missing: {check.missingEnvVars.join(', ')}
                          </div>
                        ) : null}
                      </div>
                    ))}
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <span
                    className={`inline-block size-2 rounded-full ${statusTone(workflowLabel)}`}
                  />
                  Workflow
                </div>
                <div>Run: {runtime?.workflow.runId ?? 'n/a'}</div>
                <div>Status: {workflowLabel}</div>
                <div>Phase: {runtime?.workflow.phase ?? 'idle'}</div>
                <div>
                  Duration: {formatDuration(runtime?.workflow.durationMs ?? 0)}
                </div>
                <div>
                  Started:{' '}
                  {formatTimestamp(runtime?.workflow.startedAt ?? null)}
                </div>
                {runtime?.approval.status ? (
                  <>
                    <div>
                      Approval: {runtime.approval.status}
                      {runtime.approval.toolName
                        ? ` · ${runtime.approval.toolName}`
                        : ''}
                    </div>
                    <div>
                      Approval Requested:{' '}
                      {formatTimestamp(runtime.approval.requestedAt)}
                    </div>
                    <div>
                      Approval Responded:{' '}
                      {formatTimestamp(runtime.approval.respondedAt)}
                    </div>
                  </>
                ) : null}
                {runtime?.workflow.lastError ? (
                  <div className="text-rose-500">
                    Error: {runtime.workflow.lastError}
                  </div>
                ) : null}
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  disabled={!runtime?.workflow.canCancel || submitting !== null}
                  onClick={() => void runControl('workflow', 'cancel')}
                >
                  {submitting === 'workflow' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <XCircle className="size-4" />
                  )}
                  Cancel
                </Button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <span
                    className={`inline-block size-2 rounded-full ${statusTone(sandboxLabel)}`}
                  />
                  Sandbox
                </div>
                <div>ID: {runtime?.sandbox.sandboxId ?? 'n/a'}</div>
                <div>Status: {sandboxLabel}</div>
                <div>
                  Duration: {formatDuration(runtime?.sandbox.durationMs ?? 0)}
                </div>
                <div>
                  Timeout:{' '}
                  {runtime?.sandbox.timeoutMs
                    ? formatDuration(runtime.sandbox.timeoutMs)
                    : 'n/a'}
                </div>
                <div>
                  Public Ports:{' '}
                  {runtime?.sandbox.publicPorts.length
                    ? runtime.sandbox.publicPorts.join(', ')
                    : 'n/a'}
                </div>
                <div className="break-all">
                  Last Command: {runtime?.sandbox.lastCommand ?? 'n/a'}
                </div>
                <div>
                  Last Exit Code: {runtime?.sandbox.lastExitCode ?? 'n/a'}
                </div>
                {runtime?.sandbox.lastError ? (
                  <div className="text-rose-500">
                    Error: {runtime.sandbox.lastError}
                  </div>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={!runtime?.sandbox.canStop || submitting !== null}
                  onClick={() => void runControl('sandbox', 'stop')}
                >
                  {submitting === 'sandbox' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Square className="size-4" />
                  )}
                  Stop Sandbox
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center justify-center p-2 rounded-full border border-zinc-800/10 bg-background/95 shadow-xl backdrop-blur"
        >
          <span
            className={`inline-block size-3 rounded-full ${statusTone(
              runtime?.workflow.status ?? runtime?.sandbox.status ?? 'idle',
            )}`}
          />
        </button>
      </div>
    </motion.div>
  );
}
