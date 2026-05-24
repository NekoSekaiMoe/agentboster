'use client';

import { ofetch } from 'ofetch';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface L2DecisionCardProps {
  taskId: string;
  decisionId: string;
  title: string;
  body: string;
  command: string;
  score: number;
  reason: string;
  chatId: string;
  userId?: string;
  /** ISO 8601 expiry time from the decision queue */
  expiresAt?: string;
  /** Callback when decision is resolved */
  onResolved?: (decision: string) => void;
}

type L2Action = 'pass_once' | 'pass_until' | 'reject_once' | 'reject_until';

const L2_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export function L2DecisionCard({
  taskId,
  decisionId,
  title,
  body,
  command,
  score,
  reason,
  chatId,
  userId,
  expiresAt,
  onResolved,
}: L2DecisionCardProps) {
  const [loading, setLoading] = useState(false);
  const [awaitingTimeInput, setAwaitingTimeInput] = useState(false);
  const [pendingAction, setPendingAction] = useState<L2Action | null>(null);
  const [timeValue, setTimeValue] = useState('');
  const [resolved, setResolved] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const [countdown, setCountdown] = useState('');

  // Countdown timer
  useEffect(() => {
    const deadline = expiresAt
      ? new Date(expiresAt).getTime()
      : Date.now() + L2_TIMEOUT_MS;

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

      // Visual warning when < 1 minute
      if (totalSec < 60) {
        setTimedOut(false); // still active but warning
      }
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const isDisabled = loading || timedOut;

  const submitAction = useCallback(
    async (action: L2Action, timeInput?: string) => {
      if (timedOut) {
        toast.error('决策已超时，Agent 已暂停');
        return;
      }
      setLoading(true);
      try {
        const resp = await ofetch('/api/agentd/v1/l2-confirm', {
          method: 'POST',
          body: {
            taskId,
            decisionId,
            action,
            timeInput,
            chatId,
            userId,
          },
        });

        if (resp.success) {
          if (resp.data?.awaitingTimeInput) {
            setAwaitingTimeInput(true);
            setPendingAction(action);
            return;
          }

          setResolved(true);
          setResultMessage(resp.data?.message || 'Done');
          onResolved?.(action);
          toast.success('L2 决策已处理');
        } else {
          toast.error(resp.error || '处理失败');
        }
      } catch {
        toast.error('请求失败');
      } finally {
        setLoading(false);
      }
    },
    [taskId, decisionId, chatId, userId, onResolved, timedOut],
  );

  const submitTimeInput = useCallback(() => {
    if (timedOut) {
      toast.error('决策已超时，Agent 已暂停');
      return;
    }
    if (!pendingAction) return;
    const trimmed = timeValue.trim();
    if (!trimmed) {
      toast.error('请输入时间');
      return;
    }
    submitAction(pendingAction, trimmed);
    setAwaitingTimeInput(false);
    setTimeValue('');
  }, [pendingAction, timeValue, submitAction, timedOut]);

  // Resolved state
  if (resolved) {
    return (
      <Card className="border-green-500/30">
        <CardContent className="pt-4">
          <p className="text-sm text-green-600">{resultMessage}</p>
        </CardContent>
      </Card>
    );
  }

  // Timeout state — buttons disabled, red card
  if (timedOut && !awaitingTimeInput) {
    return (
      <Card className="border-red-500/40 bg-red-50/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-red-700">
            ⏰ 决策已超时
          </CardTitle>
          <CardDescription className="text-xs space-y-1">
            <div>任务：{body}</div>
            <div>
              命令：<code className="bg-muted px-1 rounded">{command}</code>
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">
            已超时，Agent 已暂停。任务状态已设为 waiting_user。
          </p>
        </CardContent>
      </Card>
    );
  }

  const isUrgent = countdown.startsWith('0:') || countdown.startsWith('1:');

  return (
    <Card
      className={
        isUrgent
          ? 'border-red-500/50 bg-red-50/20'
          : 'border-orange-500/30'
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {/* Countdown badge */}
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded ${
              isUrgent
                ? 'bg-red-100 text-red-700 animate-pulse'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            ⏱ {countdown}
          </span>
        </div>
        <CardDescription className="text-xs space-y-1">
          <div>任务：{body}</div>
          <div>
            命令：<code className="bg-muted px-1 rounded">{command}</code>
          </div>
          <div>风险评分：{score.toFixed(1)}/1.0</div>
          <div>原因：{reason}</div>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {awaitingTimeInput && (
          <div className="space-y-2 rounded-md border border-orange-300/40 bg-orange-50/50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">⏱️ 请回复时间</p>
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
                onChange={(e) => setTimeValue(e.target.value)}
                placeholder="01000000 = 1小时, 00010000 = 1天, always"
                className="text-xs"
                disabled={isDisabled}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTimeInput();
                }}
              />
              <Button size="sm" onClick={submitTimeInput} disabled={isDisabled}>
                确认
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={isDisabled}
                onClick={() => setTimeValue('always')}
              >
                always
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={isDisabled}
                onClick={() => setTimeValue('01000000')}
              >
                1小时
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={isDisabled}
                onClick={() => setTimeValue('00010000')}
              >
                1天
              </Button>
            </div>
          </div>
        )}

        {!awaitingTimeInput && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="border-green-500/40 hover:bg-green-50 text-green-700"
              onClick={() => submitAction('pass_once')}
              disabled={isDisabled}
            >
              ✅ pass once
            </Button>
            <Button
              variant="outline"
              className="border-blue-500/40 hover:bg-blue-50 text-blue-700"
              onClick={() => submitAction('pass_until')}
              disabled={isDisabled}
            >
              ⏱ pass until...
            </Button>
            <Button
              variant="outline"
              className="border-red-500/40 hover:bg-red-50 text-red-700"
              onClick={() => submitAction('reject_once')}
              disabled={isDisabled}
            >
              ❌ reject once
            </Button>
            <Button
              variant="outline"
              className="border-red-500/40 hover:bg-red-50 text-red-700"
              onClick={() => submitAction('reject_until')}
              disabled={isDisabled}
            >
              🔕 reject until...
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
