'use client';

import { ofetch } from 'ofetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

type DecisionType = 'l2_auth' | 'question';

interface Prompt {
  question: string;
  header?: string;
  options?: string[];
  multiple?: boolean;
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
  /** Callback when decision is resolved */
  onResolved?: (decisionId: string, action: string) => void;
}

const TIMEOUT_MS = 3 * 60 * 1000;

// ── L2 action labels ──

const L2_ACTIONS: Record<string, { label: string; description: string; color: string }> = {
  pass_once:    { label: '✅ pass once',    description: '仅此次放行',                    color: 'green' },
  pass_until:   { label: '⏱ pass until...', description: '放行至指定时间',                color: 'blue' },
  reject_once:  { label: '❌ reject once',  description: '拒绝此次操作',                  color: 'red' },
  reject_until: { label: '🔕 reject until...', description: '拒绝并沉默至指定时间',        color: 'red' },
};

// ── Main component ──

export function DecisionCard({ decision, chatId, userId, onResolved }: DecisionCardProps) {
  const isL2 = decision.type === 'l2_auth';

  // L2 state
  const [awaitingTimeInput, setAwaitingTimeInput] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [timeValue, setTimeValue] = useState('');

  // Question state
  const [selectedOptions, setSelectedOptions] = useState<string[][]>(
    () => (decision.prompts ?? []).map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(
    () => (decision.prompts ?? []).map(() => ''),
  );

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
      if (timedOut) { toast.error('决策已超时，Agent 已暂停'); return; }
      setLoading(true);
      try {
        const resp = await ofetch('/api/agentd/v1/l2-confirm', {
          method: 'POST',
          body: { task_id: decision.task_id, decision_id: decision.decision_id, action, timeInput, chat_id: chatId, user_id: userId },
        });
        if (resp.success) {
          if (resp.data?.awaitingTimeInput) {
            setAwaitingTimeInput(true);
            setPendingAction(action);
            return;
          }
          setResolved(true);
          setResultMessage(resp.data?.message || 'Done');
          onResolved?.(decision.decision_id, action);
          toast.success('已处理');
        } else {
          toast.error(resp.error || '处理失败');
        }
      } catch { toast.error('请求失败'); }
      finally { setLoading(false); }
    },
    [decision, chatId, userId, onResolved, timedOut],
  );

  const submitTimeInput = useCallback(() => {
    if (timedOut) { toast.error('决策已超时'); return; }
    if (!pendingAction) return;
    const trimmed = timeValue.trim();
    if (!trimmed) { toast.error('请输入时间'); return; }
    submitL2Action(pendingAction, trimmed);
    setAwaitingTimeInput(false);
    setTimeValue('');
  }, [pendingAction, timeValue, submitL2Action, timedOut]);

  const submitQuestionAnswers = useCallback(async () => {
    if (timedOut) { toast.error('问题已超时'); return; }
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
    } catch { toast.error('提交失败'); }
    finally { setLoading(false); }
  }, [selectedOptions, customAnswers, decision.decision_id, onResolved, timedOut]);

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
          <CardTitle className="text-base text-red-700">⏰ {isL2 ? '决策' : '问题'}已超时</CardTitle>
          <CardDescription className="text-xs">
            {isL2 && <div>命令：<code className="bg-muted px-1 rounded">{decision.command}</code></div>}
            {!isL2 && decision.question && <div>{decision.question}</div>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">
            Agent 已暂停。{isL2 ? '任务状态已设为 waiting_user。' : '您可以稍后重新发送指令。'}
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Card border style ──

  const borderColor = isL2
    ? (isUrgent ? 'border-red-500/50 bg-red-50/20' : 'border-orange-500/30')
    : (isUrgent ? 'border-amber-500/50 bg-amber-50/20' : 'border-blue-500/30');

  // ── Render ──

  return (
    <Card className={borderColor}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {isL2 ? '⚠️ 高风险操作需要您的授权' : '💬 Agent 向您提问'}
          </CardTitle>
          <span className={`text-xs font-mono px-2 py-0.5 rounded ${
            isUrgent ? 'bg-red-100 text-red-700 animate-pulse' : 'bg-muted text-muted-foreground'
          }`}>
            ⏱ {countdown}
          </span>
        </div>
        <CardDescription className="text-xs space-y-1">
          {/* L2 context */}
          {isL2 && decision.command && (
            <>
              <div>任务：{decision.command}</div>
              <div>命令：<code className="bg-muted px-1 rounded">{decision.command}</code></div>
              {decision.score !== undefined && <div>风险评分：{decision.score.toFixed(1)}/1.0</div>}
              {decision.reason && <div>原因：{decision.reason}</div>}
            </>
          )}
          {/* Question context */}
          {!isL2 && decision.question && <div>{decision.question}</div>}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ── L2: time input (pass_until / reject_until) ── */}
        {isL2 && awaitingTimeInput && (
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

        {/* ── L2: 4 action buttons ── */}
        {isL2 && !awaitingTimeInput && (
          <div className="grid grid-cols-2 gap-2">
            {decision.options?.map((action) => {
              const cfg = L2_ACTIONS[action] || { label: action, description: '', color: 'gray' };
              const colorClass = cfg.color === 'green'
                ? 'border-green-500/40 hover:bg-green-50 text-green-700'
                : cfg.color === 'blue'
                  ? 'border-blue-500/40 hover:bg-blue-50 text-blue-700'
                  : 'border-red-500/40 hover:bg-red-50 text-red-700';
              return (
                <Button key={action} variant="outline" className={colorClass}
                  onClick={() => submitL2Action(action)} disabled={isDisabled}>
                  {cfg.label}
                </Button>
              );
            })}
          </div>
        )}

        {/* ── Question: dynamic prompts ── */}
        {!isL2 && (decision.prompts ?? []).map((prompt, pIdx) => (
          <div key={pIdx} className="space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground mt-0.5">{pIdx + 1}.</span>
              <div className="flex-1">
                <p className="text-sm font-medium">{prompt.question}</p>
                {prompt.header && <p className="text-xs text-muted-foreground mt-0.5">[{prompt.header}]</p>}
              </div>
            </div>
            <div className="ml-4 space-y-1.5">
              {prompt.multiple ? (
                prompt.options?.map((opt, oIdx) => (
                  <div key={oIdx} className="flex items-center gap-2">
                    <Checkbox
                      id={`q${pIdx}-o${oIdx}`}
                      checked={selectedOptions[pIdx]?.includes(opt)}
                      onCheckedChange={() => {
                        setSelectedOptions(prev => {
                          const next = prev.map(a => [...a]);
                          const cur = next[pIdx];
                          const idx = cur.indexOf(opt);
                          if (idx >= 0) cur.splice(idx, 1); else cur.push(opt);
                          return next;
                        });
                      }}
                      disabled={isDisabled}
                    />
                    <Label htmlFor={`q${pIdx}-o${oIdx}`} className="text-sm cursor-pointer">{opt}</Label>
                  </div>
                ))
              ) : (
                <RadioGroup
                  value={selectedOptions[pIdx]?.[0] || ''}
                  onValueChange={(val) => {
                    setSelectedOptions(prev => {
                      const next = prev.map(a => [...a]);
                      next[pIdx] = [val];
                      return next;
                    });
                  }}
                >
                  {prompt.options?.map((opt, oIdx) => (
                    <div key={oIdx} className="flex items-center gap-2">
                      <RadioGroupItem value={opt} id={`q${pIdx}-o${oIdx}`} disabled={isDisabled} />
                      <Label htmlFor={`q${pIdx}-o${oIdx}`} className="text-sm cursor-pointer">{opt}</Label>
                    </div>
                  ))}
                </RadioGroup>
              )}
              <Input
                value={customAnswers[pIdx] || ''}
                onChange={(e) => {
                  setCustomAnswers(prev => {
                    const next = [...prev]; next[pIdx] = e.target.value; return next;
                  });
                }}
                placeholder="或输入自定义答案..."
                className="text-sm" disabled={isDisabled}
              />
            </div>
          </div>
        ))}

        {/* ── Question: submit ── */}
        {!isL2 && (decision.prompts?.length ?? 0) > 0 && (
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" disabled={isDisabled}
              onClick={async () => {
                try {
                  await ofetch(`/api/agentd/v1/decisions/${decision.decision_id}/reject`, { method: 'POST' });
                  setResolved(true);
                  toast.info('已忽略');
                } catch { toast.error('操作失败'); }
              }}>
              忽略
            </Button>
            <Button size="sm" onClick={submitQuestionAnswers} disabled={isDisabled}>
              提交回答
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Shared sub-component: time input form ──

function TimeInputForm({ countdown, timeValue, onTimeChange, onSubmit, onAlways, on1Hour, on1Day, disabled }: {
  countdown: string; timeValue: string; onTimeChange: (v: string) => void;
  onSubmit: () => void; onAlways: () => void; on1Hour: () => void; on1Day: () => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-orange-300/40 bg-orange-50/50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">⏱️ 请回复时间</p>
        <span className="text-xs font-mono text-muted-foreground">{countdown}</span>
      </div>
      <p className="text-xs text-muted-foreground">格式：hhddmmyy（时-日-月-年）或 always</p>
      <div className="flex gap-2">
        <Input value={timeValue} onChange={(e) => onTimeChange(e.target.value)}
          placeholder="01000000 = 1小时, 00010000 = 1天, always"
          className="text-xs" disabled={disabled}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }} />
        <Button size="sm" onClick={onSubmit} disabled={disabled}>确认</Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="text-xs" disabled={disabled} onClick={onAlways}>always</Button>
        <Button size="sm" variant="outline" className="text-xs" disabled={disabled} onClick={on1Hour}>1小时</Button>
        <Button size="sm" variant="outline" className="text-xs" disabled={disabled} onClick={on1Day}>1天</Button>
      </div>
    </div>
  );
}
