'use client';

import { ofetch } from 'ofetch';
import { useCallback, useState } from 'react';
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
  /** Callback when decision is resolved */
  onResolved?: (decision: string) => void;
}

type L2Action = 'pass_once' | 'pass_until' | 'reject_once' | 'reject_until';

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
  onResolved,
}: L2DecisionCardProps) {
  const [loading, setLoading] = useState(false);
  const [awaitingTimeInput, setAwaitingTimeInput] = useState(false);
  const [pendingAction, setPendingAction] = useState<L2Action | null>(null);
  const [timeValue, setTimeValue] = useState('');
  const [resolved, setResolved] = useState(false);
  const [resultMessage, setResultMessage] = useState('');

  const submitAction = useCallback(
    async (action: L2Action, timeInput?: string) => {
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
          // If awaiting time input, show the time input field
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
      } catch (err) {
        toast.error('请求失败');
      } finally {
        setLoading(false);
      }
    },
    [taskId, decisionId, chatId, userId, onResolved],
  );

  const submitTimeInput = useCallback(() => {
    if (!pendingAction) return;
    const trimmed = timeValue.trim();
    if (!trimmed) {
      toast.error('请输入时间');
      return;
    }
    submitAction(pendingAction, trimmed);
    setAwaitingTimeInput(false);
    setTimeValue('');
  }, [pendingAction, timeValue, submitAction]);

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

  return (
    <Card className="border-orange-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
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
        {/* Time input field (shown after clicking pass_until / reject_until) */}
        {awaitingTimeInput && (
          <div className="space-y-2 rounded-md border border-orange-300/40 bg-orange-50/50 p-3">
            <p className="text-xs font-medium">⏱️ 请回复时间</p>
            <p className="text-xs text-muted-foreground">
              格式：hhddmmyy（时-日-月-年）或 always
            </p>
            <div className="flex gap-2">
              <Input
                value={timeValue}
                onChange={(e) => setTimeValue(e.target.value)}
                placeholder="01000000 = 1小时, 00010000 = 1天, always"
                className="text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTimeInput();
                }}
              />
              <Button
                size="sm"
                onClick={submitTimeInput}
                disabled={loading}
              >
                确认
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => {
                  setTimeValue('always');
                }}
              >
                always
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => {
                  setTimeValue('01000000');
                }}
              >
                1小时
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => {
                  setTimeValue('00010000');
                }}
              >
                1天
              </Button>
            </div>
          </div>
        )}

        {/* Four buttons: 2x2 grid */}
        {!awaitingTimeInput && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="border-green-500/40 hover:bg-green-50 text-green-700"
              onClick={() => submitAction('pass_once')}
              disabled={loading}
            >
              ✅ pass once
            </Button>
            <Button
              variant="outline"
              className="border-blue-500/40 hover:bg-blue-50 text-blue-700"
              onClick={() => submitAction('pass_until')}
              disabled={loading}
            >
              ⏱ pass until...
            </Button>
            <Button
              variant="outline"
              className="border-red-500/40 hover:bg-red-50 text-red-700"
              onClick={() => submitAction('reject_once')}
              disabled={loading}
            >
              ❌ reject once
            </Button>
            <Button
              variant="outline"
              className="border-red-500/40 hover:bg-red-50 text-red-700"
              onClick={() => submitAction('reject_until')}
              disabled={loading}
            >
              🔕 reject until...
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
