'use client';

import {
  AlertTriangle,
  Check,
  Clock,
  GitBranch,
  MessageSquare,
  RefreshCw,
  VolumeX,
  X,
} from 'lucide-react';
import { ofetch } from 'ofetch';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

// ── Types (mirror Go Decision struct) ──

type DecisionType = 'l2_auth' | 'question' | 'conflict' | 'branch';

interface Prompt {
  question: string;
  header?: string;
  options?: string[];
  multiple?: boolean;
}

interface ConflictFile {
  path: string;
  ours?: string;
  theirs?: string;
  current?: string;
}

interface ConflictData {
  title?: string;
  files: ConflictFile[];
}

interface BranchPlan {
  label: string;
  description?: string;
  details?: string;
}

interface BranchData {
  title?: string;
  plan_a: BranchPlan;
  plan_b: BranchPlan;
  allow_custom: boolean;
}

interface Decision {
  decision_id: string;
  type: DecisionType;
  task_id: string;
  session_id: string;
  command?: string;
  score?: number;
  reason?: string;
  question?: string;
  prompts?: Prompt[];
  options?: string[];
  conflict?: ConflictData;
  branch?: BranchData;
  status: string;
  created_at: string;
  timeout_at: string;
  answers?: string[][];
  action?: string;
}

interface DecisionCardProps {
  decision: Decision;
  chatId: string;
  userId?: string;
  onResolved?: (decisionId: string, action: string) => void;
}

const TIMEOUT_MS = 3 * 60 * 1000;

// ── L2 action labels ──

const L2_ACTIONS: Record<
  string,
  {
    label: string;
    description: string;
    color: string;
    icon: ReactNode;
  }
> = {
  pass_once: {
    label: 'pass once',
    description: '仅此次放行',
    color: 'green',
    icon: <Check className="size-4" />,
  },
  pass_until: {
    label: 'pass until...',
    description: '放行至指定时间',
    color: 'blue',
    icon: <Clock className="size-4" />,
  },
  reject_once: {
    label: 'reject once',
    description: '拒绝此次操作',
    color: 'red',
    icon: <X className="size-4" />,
  },
  reject_until: {
    label: 'reject until...',
    description: '拒绝并沉默至指定时间',
    color: 'red',
    icon: <VolumeX className="size-4" />,
  },
};

// ── Main component ──

export function DecisionCard({
  decision,
  chatId,
  userId,
  onResolved,
}: DecisionCardProps) {
  // L2 state
  const [awaitingTimeInput, setAwaitingTimeInput] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [timeValue, setTimeValue] = useState('');

  // Question state
  const [selectedOptions, setSelectedOptions] = useState<string[][]>(() =>
    (decision.prompts ?? []).map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    (decision.prompts ?? []).map(() => ''),
  );

  // Conflict state: per-file resolution choice
  const [conflictResolutions, setConflictResolutions] = useState<string[]>(() =>
    (decision.conflict?.files ?? []).map(() => ''),
  );
  const [conflictCustom, setConflictCustom] = useState<string[]>(() =>
    (decision.conflict?.files ?? []).map(() => ''),
  );

  // Branch state
  const [branchChoice, setBranchChoice] = useState<string>('');
  const [branchCustom, setBranchCustom] = useState('');

  // Common state
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const [countdown, setCountdown] = useState('');

  // Countdown
  useEffect(() => {
    const deadline = new Date(decision.timeout_at).getTime();

    const update = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setTimedOut(true);
        setCountdown('已超时');
        return;
      }
      const totalSec = Math.floor(remaining / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      setCountdown(`${min}:${sec.toString().padStart(2, '0')}`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [decision.timeout_at]);

  const isDisabled = loading || timedOut;
  const isUrgent = countdown.startsWith('0:') || countdown.startsWith('1:');

  // ── Submit helpers ──

  const submitL2Action = useCallback(
    async (action: string, timeInput?: string) => {
      if (timedOut) {
        toast.error('决策已超时，Agent 已暂停');
        return;
      }
      setLoading(true);
      try {
        let reply = 'once';
        if (action === 'pass_until' || action === 'reject_until') {
          reply = 'always';
        } else if (action.startsWith('reject')) {
          reply = 'reject';
        }

        const resp = await ofetch(
          `/api/agentd/v1/decisions/${decision.decision_id}/resolve`,
          {
            method: 'POST',
            body: {
              reply,
              answers: [[action]],
              time_input: timeInput,
              chat_id: chatId,
              user_id: userId,
            },
          },
        );
        if (resp.success) {
          setResolved(true);
          setResultMessage(resp.data?.message || 'Done');
          onResolved?.(decision.decision_id, action);
          toast.success('已处理');
        } else {
          toast.error(resp.error || '处理失败');
        }
      } catch {
        toast.error('请求失败');
      } finally {
        setLoading(false);
      }
    },
    [decision, chatId, userId, onResolved, timedOut],
  );

  const submitTimeInput = useCallback(() => {
    if (timedOut) {
      toast.error('决策已超时');
      return;
    }
    if (!pendingAction) return;
    const trimmed = timeValue.trim();
    if (!trimmed) {
      toast.error('请输入时间');
      return;
    }
    submitL2Action(pendingAction, trimmed);
    setAwaitingTimeInput(false);
    setTimeValue('');
  }, [pendingAction, timeValue, submitL2Action, timedOut]);

  const submitQuestionAnswers = useCallback(async () => {
    if (timedOut) {
      toast.error('问题已超时');
      return;
    }
    setLoading(true);
    try {
      const finalAnswers = selectedOptions.map((opts, i) => {
        const custom = customAnswers[i]?.trim();
        return custom ? [...opts, custom] : opts;
      });
      await ofetch(`/api/agentd/v1/decisions/${decision.decision_id}/resolve`, {
        method: 'POST',
        body: { answers: finalAnswers },
      });
      setResolved(true);
      setResultMessage('✓ 已回答');
      onResolved?.(decision.decision_id, 'answered');
      toast.success('已回答');
    } catch {
      toast.error('提交失败');
    } finally {
      setLoading(false);
    }
  }, [
    selectedOptions,
    customAnswers,
    decision.decision_id,
    onResolved,
    timedOut,
  ]);

  const submitConflictResolutions = useCallback(async () => {
    if (timedOut) {
      toast.error('冲突解决已超时');
      return;
    }
    const hasEmpty = conflictResolutions.some(
      (r, i) => !r && !conflictCustom[i]?.trim(),
    );
    if (hasEmpty) {
      toast.error('请为所有冲突文件选择解决方式');
      return;
    }
    setLoading(true);
    try {
      const answers = conflictResolutions.map((choice, i) => {
        const custom = conflictCustom[i]?.trim();
        return custom ? [choice, custom] : [choice];
      });
      await ofetch(`/api/agentd/v1/decisions/${decision.decision_id}/resolve`, {
        method: 'POST',
        body: { answers },
      });
      setResolved(true);
      setResultMessage('✓ 冲突已解决');
      onResolved?.(decision.decision_id, 'resolved');
      toast.success('冲突已解决');
    } catch {
      toast.error('提交失败');
    } finally {
      setLoading(false);
    }
  }, [
    conflictResolutions,
    conflictCustom,
    decision.decision_id,
    onResolved,
    timedOut,
  ]);

  const submitBranchChoice = useCallback(async () => {
    if (timedOut) {
      toast.error('分支决策已超时');
      return;
    }
    if (!branchChoice) {
      toast.error('请选择方案');
      return;
    }
    setLoading(true);
    try {
      const answer =
        branchChoice === 'custom' ? `custom:${branchCustom}` : branchChoice;
      await ofetch(`/api/agentd/v1/decisions/${decision.decision_id}/resolve`, {
        method: 'POST',
        body: { answers: [[answer]] },
      });
      setResolved(true);
      setResultMessage(
        `✓ 已选择：${branchChoice === 'custom' ? '自定义方案' : branchChoice}`,
      );
      onResolved?.(decision.decision_id, branchChoice);
      toast.success('方案已选择');
    } catch {
      toast.error('提交失败');
    } finally {
      setLoading(false);
    }
  }, [branchChoice, branchCustom, decision.decision_id, onResolved, timedOut]);

  // ── Resolved state ──

  if (resolved) {
    return (
      <Card className="border-green-500/30">
        <CardContent className="pt-4">
          <p className="text-sm text-green-600">{resultMessage}</p>
        </CardContent>
      </Card>
    );
  }

  // ── Timeout state ──

  if (timedOut && !awaitingTimeInput) {
    return (
      <Card className="border-red-500/40 bg-red-50/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-1.5 text-base text-red-700">
            <Clock className="size-4" />
            决策已超时
          </CardTitle>
          <CardDescription className="text-xs">
            {decision.type === 'l2_auth' && decision.command && (
              <div>
                命令：
                <code className="bg-muted px-1 rounded">
                  {decision.command}
                </code>
              </div>
            )}
            {decision.type === 'question' && decision.question && (
              <div>{decision.question}</div>
            )}
            {decision.type === 'conflict' && (
              <div>冲突文件：{decision.conflict?.files.length ?? 0} 个</div>
            )}
            {decision.type === 'branch' && <div>任务分支决策</div>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">
            Agent 已暂停。您可以稍后重新发送指令。
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Card border style ──

  const borderColor =
    decision.type === 'l2_auth'
      ? isUrgent
        ? 'border-red-500/50 bg-red-50/20'
        : 'border-orange-500/30'
      : decision.type === 'conflict'
        ? isUrgent
          ? 'border-red-500/50 bg-red-50/20'
          : 'border-purple-500/30'
        : decision.type === 'branch'
          ? isUrgent
            ? 'border-amber-500/50 bg-amber-50/20'
            : 'border-cyan-500/30'
          : isUrgent
            ? 'border-amber-500/50 bg-amber-50/20'
            : 'border-blue-500/30';

  const titleIcon =
    decision.type === 'l2_auth' ? (
      <AlertTriangle className="size-4 text-orange-600" />
    ) : decision.type === 'conflict' ? (
      <GitBranch className="size-4 text-purple-600" />
    ) : decision.type === 'branch' ? (
      <RefreshCw className="size-4 text-cyan-600" />
    ) : (
      <MessageSquare className="size-4 text-blue-600" />
    );

  const titleText =
    decision.type === 'l2_auth'
      ? '高风险操作需要您的授权'
      : decision.type === 'conflict'
        ? '冲突解决'
        : decision.type === 'branch'
          ? '任务分支决策'
          : 'Agent 向您提问';

  // ── Render ──

  return (
    <Card className={borderColor}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-1.5 text-base">
            {titleIcon} {titleText}
          </CardTitle>
          <span
            className={`flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded ${
              isUrgent
                ? 'bg-red-100 text-red-700 animate-pulse'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <Clock className="size-3" /> {countdown}
          </span>
        </div>
        <CardDescription className="text-xs space-y-1">
          {decision.type === 'l2_auth' && decision.command && (
            <>
              <div>任务：{decision.command}</div>
              <div>
                命令：
                <code className="bg-muted px-1 rounded">
                  {decision.command}
                </code>
              </div>
              {decision.score !== undefined && (
                <div>风险评分：{decision.score.toFixed(1)}/1.0</div>
              )}
              {decision.reason && <div>原因：{decision.reason}</div>}
            </>
          )}
          {decision.type === 'question' && decision.question && (
            <div>{decision.question}</div>
          )}
          {decision.type === 'conflict' && decision.conflict && (
            <div>
              {decision.conflict.title ??
                `${decision.conflict.files.length} 个文件有冲突`}
            </div>
          )}
          {decision.type === 'branch' && decision.branch && (
            <div>{decision.branch.title ?? '请选择执行方案'}</div>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ═══════════════════════════════════════════════════════════════
            L2 AUTH
            ═══════════════════════════════════════════════════════════════ */}

        {decision.type === 'l2_auth' && awaitingTimeInput && (
          <TimeInputForm
            countdown={countdown}
            timeValue={timeValue}
            onTimeChange={setTimeValue}
            onSubmit={submitTimeInput}
            onAlways={() => setTimeValue('always')}
            on1Hour={() => setTimeValue('01000000')}
            on1Day={() => setTimeValue('00010000')}
            disabled={isDisabled}
          />
        )}

        {decision.type === 'l2_auth' && !awaitingTimeInput && (
          <div className="grid grid-cols-2 gap-2">
            {decision.options?.map((action) => {
              const cfg = L2_ACTIONS[action] || {
                label: action,
                description: '',
                color: 'gray',
                icon: null,
              };
              const colorClass =
                cfg.color === 'green'
                  ? 'border-green-500/40 hover:bg-green-50 text-green-700'
                  : cfg.color === 'blue'
                    ? 'border-blue-500/40 hover:bg-blue-50 text-blue-700'
                    : 'border-red-500/40 hover:bg-red-50 text-red-700';
              return (
                <Button
                  key={action}
                  variant="outline"
                  className={colorClass}
                  onClick={() => submitL2Action(action)}
                  disabled={isDisabled}
                >
                  {cfg.icon}
                  {cfg.label}
                </Button>
              );
            })}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            QUESTION
            ═══════════════════════════════════════════════════════════════ */}

        {decision.type === 'question' &&
          (decision.prompts ?? []).map((prompt, pIdx) => (
            <div
              key={`q-${pIdx}-${prompt.question.slice(0, 30)}`}
              className="space-y-2"
            >
              <div className="flex items-start gap-2">
                <span className="text-xs text-muted-foreground mt-0.5">
                  {pIdx + 1}.
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{prompt.question}</p>
                  {prompt.header && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      [{prompt.header}]
                    </p>
                  )}
                </div>
              </div>
              <div className="ml-4 space-y-1.5">
                {prompt.multiple ? (
                  prompt.options?.map((opt, oIdx) => (
                    <div
                      key={`q-${pIdx}-o-${oIdx}-${opt.slice(0, 20)}`}
                      className="flex items-center gap-2"
                    >
                      <Checkbox
                        id={`q${pIdx}-o${oIdx}`}
                        checked={selectedOptions[pIdx]?.includes(opt)}
                        onCheckedChange={() => {
                          setSelectedOptions((prev) => {
                            const next = prev.map((a) => [...a]);
                            const cur = next[pIdx];
                            const idx = cur.indexOf(opt);
                            if (idx >= 0) cur.splice(idx, 1);
                            else cur.push(opt);
                            return next;
                          });
                        }}
                        disabled={isDisabled}
                      />
                      <Label
                        htmlFor={`q${pIdx}-o${oIdx}`}
                        className="text-sm cursor-pointer"
                      >
                        {opt}
                      </Label>
                    </div>
                  ))
                ) : (
                  <RadioGroup
                    value={selectedOptions[pIdx]?.[0] || ''}
                    onValueChange={(val) => {
                      setSelectedOptions((prev) => {
                        const next = prev.map((a) => [...a]);
                        next[pIdx] = [val];
                        return next;
                      });
                    }}
                  >
                    {prompt.options?.map((opt, oIdx) => (
                      <div
                        key={`q-${pIdx}-radio-${oIdx}-${opt.slice(0, 20)}`}
                        className="flex items-center gap-2"
                      >
                        <RadioGroupItem
                          value={opt}
                          id={`q${pIdx}-o${oIdx}`}
                          disabled={isDisabled}
                        />
                        <Label
                          htmlFor={`q${pIdx}-o${oIdx}`}
                          className="text-sm cursor-pointer"
                        >
                          {opt}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
                <Input
                  value={customAnswers[pIdx] || ''}
                  onChange={(e) => {
                    setCustomAnswers((prev) => {
                      const next = [...prev];
                      next[pIdx] = e.target.value;
                      return next;
                    });
                  }}
                  placeholder="或输入自定义答案..."
                  className="text-sm"
                  disabled={isDisabled}
                />
              </div>
            </div>
          ))}

        {decision.type === 'question' &&
          (decision.prompts?.length ?? 0) > 0 && (
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isDisabled}
                onClick={async () => {
                  try {
                    await ofetch(
                      `/api/agentd/v1/decisions/${decision.decision_id}/reject`,
                      { method: 'POST' },
                    );
                    setResolved(true);
                    toast.info('已忽略');
                  } catch {
                    toast.error('操作失败');
                  }
                }}
              >
                忽略
              </Button>
              <Button
                size="sm"
                onClick={submitQuestionAnswers}
                disabled={isDisabled}
              >
                提交回答
              </Button>
            </div>
          )}

        {/* ═══════════════════════════════════════════════════════════════
            CONFLICT RESOLUTION
            ═══════════════════════════════════════════════════════════════ */}

        {decision.type === 'conflict' && decision.conflict && (
          <div className="space-y-3">
            {decision.conflict.files.map((file, fIdx) => (
              <div
                key={`conflict-${fIdx}-${file.path}`}
                className="rounded-md border border-purple-200/50 bg-purple-50/30 p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                    {file.path}
                  </code>
                </div>
                {(file.ours || file.theirs) && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {file.ours && (
                      <div className="rounded border border-green-200/50 bg-green-50/30 p-2">
                        <p className="font-medium text-green-700 mb-1">Ours</p>
                        <pre className="whitespace-pre-wrap text-muted-foreground">
                          {file.ours}
                        </pre>
                      </div>
                    )}
                    {file.theirs && (
                      <div className="rounded border border-blue-200/50 bg-blue-50/30 p-2">
                        <p className="font-medium text-blue-700 mb-1">Theirs</p>
                        <pre className="whitespace-pre-wrap text-muted-foreground">
                          {file.theirs}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
                <RadioGroup
                  value={conflictResolutions[fIdx] || ''}
                  onValueChange={(val) => {
                    setConflictResolutions((prev) => {
                      const next = [...prev];
                      next[fIdx] = val;
                      return next;
                    });
                  }}
                >
                  <div className="flex flex-wrap gap-3">
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem
                        value="ours"
                        id={`cf-${fIdx}-ours`}
                        disabled={isDisabled}
                      />
                      <Label
                        htmlFor={`cf-${fIdx}-ours`}
                        className="text-xs cursor-pointer text-green-700"
                      >
                        ours
                      </Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem
                        value="theirs"
                        id={`cf-${fIdx}-theirs`}
                        disabled={isDisabled}
                      />
                      <Label
                        htmlFor={`cf-${fIdx}-theirs`}
                        className="text-xs cursor-pointer text-blue-700"
                      >
                        theirs
                      </Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem
                        value="manual"
                        id={`cf-${fIdx}-manual`}
                        disabled={isDisabled}
                      />
                      <Label
                        htmlFor={`cf-${fIdx}-manual`}
                        className="text-xs cursor-pointer text-amber-700"
                      >
                        manual
                      </Label>
                    </div>
                  </div>
                </RadioGroup>
                {conflictResolutions[fIdx] === 'manual' && (
                  <Input
                    value={conflictCustom[fIdx] || ''}
                    onChange={(e) => {
                      setConflictCustom((prev) => {
                        const next = [...prev];
                        next[fIdx] = e.target.value;
                        return next;
                      });
                    }}
                    placeholder="输入手动解决内容..."
                    className="text-xs"
                    disabled={isDisabled}
                  />
                )}
              </div>
            ))}
            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                onClick={submitConflictResolutions}
                disabled={isDisabled}
              >
                提交冲突解决方案
              </Button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            TASK BRANCH DECISION
            ═══════════════════════════════════════════════════════════════ */}

        {decision.type === 'branch' && decision.branch && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Plan A */}
              <PlanCard
                label={decision.branch.plan_a.label}
                description={decision.branch.plan_a.description}
                details={decision.branch.plan_a.details}
                selected={branchChoice === 'plan_a'}
                onSelect={() => setBranchChoice('plan_a')}
                color="green"
                disabled={isDisabled}
                radioId="branch-plan-a"
              />
              {/* Plan B */}
              <PlanCard
                label={decision.branch.plan_b.label}
                description={decision.branch.plan_b.description}
                details={decision.branch.plan_b.details}
                selected={branchChoice === 'plan_b'}
                onSelect={() => setBranchChoice('plan_b')}
                color="blue"
                disabled={isDisabled}
                radioId="branch-plan-b"
              />
            </div>
            {decision.branch.allow_custom && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <RadioGroup
                    value={branchChoice}
                    onValueChange={setBranchChoice}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="custom"
                        id="branch-custom"
                        disabled={isDisabled}
                      />
                      <Label
                        htmlFor="branch-custom"
                        className="text-sm cursor-pointer"
                      >
                        自定义方案
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
                {branchChoice === 'custom' && (
                  <Input
                    value={branchCustom}
                    onChange={(e) => setBranchCustom(e.target.value)}
                    placeholder="输入自定义方案..."
                    className="text-sm"
                    disabled={isDisabled}
                  />
                )}
              </div>
            )}
            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                onClick={submitBranchChoice}
                disabled={isDisabled}
              >
                确认选择
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-component: time input form ──

function TimeInputForm({
  countdown,
  timeValue,
  onTimeChange,
  onSubmit,
  onAlways,
  on1Hour,
  on1Day,
  disabled,
}: {
  countdown: string;
  timeValue: string;
  onTimeChange: (v: string) => void;
  onSubmit: () => void;
  onAlways: () => void;
  on1Hour: () => void;
  on1Day: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-orange-300/40 bg-orange-50/50 p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1 text-xs font-medium">
          <Clock className="size-3" /> 请回复时间
        </p>
        <span className="text-xs font-mono text-muted-foreground">
          {countdown}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        格式：hhddmmyy（时-日-月-年）或 always
      </p>
      <div className="flex gap-2">
        <Input
          value={timeValue}
          onChange={(e) => onTimeChange(e.target.value)}
          placeholder="01000000 = 1小时, 00010000 = 1天, always"
          className="text-xs"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <Button size="sm" onClick={onSubmit} disabled={disabled}>
          确认
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={disabled}
          onClick={onAlways}
        >
          always
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={disabled}
          onClick={on1Hour}
        >
          1小时
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={disabled}
          onClick={on1Day}
        >
          1天
        </Button>
      </div>
    </div>
  );
}

// ── Sub-component: branch plan card ──

function PlanCard({
  label,
  description,
  details,
  selected,
  onSelect,
  color,
  disabled,
  radioId,
}: {
  label: string;
  description?: string;
  details?: string;
  selected: boolean;
  onSelect: () => void;
  color: 'green' | 'blue';
  disabled: boolean;
  radioId: string;
}) {
  const borderClass =
    color === 'green'
      ? selected
        ? 'border-green-500 bg-green-50/30'
        : 'border-green-200/50 hover:border-green-300'
      : selected
        ? 'border-blue-500 bg-blue-50/30'
        : 'border-blue-200/50 hover:border-blue-300';

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={`rounded-md border p-3 cursor-pointer transition-colors ${borderClass}`}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <RadioGroup
          value={selected ? 'selected' : ''}
          onValueChange={() => !disabled && onSelect()}
        >
          <RadioGroupItem value="selected" id={radioId} disabled={disabled} />
        </RadioGroup>
        <Label
          htmlFor={radioId}
          className="text-sm font-semibold cursor-pointer"
        >
          {label}
        </Label>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground ml-6">{description}</p>
      )}
      {details && (
        <pre className="text-xs text-muted-foreground mt-2 ml-6 whitespace-pre-wrap">
          {details}
        </pre>
      )}
    </div>
  );
}
