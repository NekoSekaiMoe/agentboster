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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

interface QuestionRequest {
  id: string;
  session_id: string;
  prompts: QuestionPrompt[];
  status: string;
  created_at: string;
}

interface AskQuestionCardProps {
  /** The question request from the agent */
  request: QuestionRequest;
  /** Callback when question is resolved */
  onResolved?: (questionId: string, answers: string[][]) => void;
}

const QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

export function AskQuestionCard({ request, onResolved }: AskQuestionCardProps) {
  const [answers, setAnswers] = useState<string[][]>(
    () => request.prompts.map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(
    () => request.prompts.map(() => ''),
  );
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [countdown, setCountdown] = useState('');

  const deadline = new Date(request.created_at).getTime() + QUESTION_TIMEOUT_MS;

  useEffect(() => {
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
  }, [deadline]);

  const toggleOption = useCallback(
    (promptIndex: number, label: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        const current = [...next[promptIndex]];
        const idx = current.indexOf(label);
        if (idx >= 0) {
          current.splice(idx, 1);
        } else {
          // If not multiple, replace
          if (!request.prompts[promptIndex].multiple) {
            next[promptIndex] = [label];
            return next;
          }
          current.push(label);
        }
        next[promptIndex] = current;
        return next;
      });
    },
    [request.prompts],
  );

  const submitAnswers = useCallback(async () => {
    if (timedOut) {
      toast.error('问题已超时');
      return;
    }
    setLoading(true);
    try {
      // Merge custom answers
      const finalAnswers = answers.map((ans, i) => {
        const custom = customAnswers[i]?.trim();
        if (custom) {
          return [...ans, custom];
        }
        return ans;
      });

      await ofetch(`/api/agentd/v1/questions/${request.id}/reply`, {
        method: 'POST',
        body: { answers: finalAnswers },
      });

      setResolved(true);
      toast.success('已回答');
      onResolved?.(request.id, finalAnswers);
    } catch {
      toast.error('提交失败');
    } finally {
      setLoading(false);
    }
  }, [answers, customAnswers, request.id, onResolved, timedOut]);

  const dismissQuestion = useCallback(async () => {
    try {
      await ofetch(`/api/agentd/v1/questions/${request.id}/reject`, {
        method: 'POST',
      });
      setResolved(true);
      toast.info('已忽略问题');
    } catch {
      toast.error('操作失败');
    }
  }, [request.id]);

  if (resolved) {
    return (
      <Card className="border-green-500/30">
        <CardContent className="pt-4">
          <p className="text-sm text-green-600">✓ 已处理</p>
        </CardContent>
      </Card>
    );
  }

  if (timedOut) {
    return (
      <Card className="border-gray-400/40 bg-gray-50/30">
        <CardContent className="pt-4">
          <p className="text-sm text-gray-500">⏰ 问题已超时，Agent 将继续使用默认行为</p>
        </CardContent>
      </Card>
    );
  }

  const isUrgent = countdown.startsWith('0:') || countdown.startsWith('1:');

  return (
    <Card
      className={
        isUrgent
          ? 'border-amber-500/50 bg-amber-50/20'
          : 'border-blue-500/30'
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">💬 Agent 向您提问</CardTitle>
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded ${
              isUrgent
                ? 'bg-amber-100 text-amber-700 animate-pulse'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            ⏱ {countdown}
          </span>
        </div>
        <CardDescription className="text-xs">
          会话: {request.session_id.slice(0, 8)}...
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {request.prompts.map((prompt, pIdx) => (
          <div key={pIdx} className="space-y-2">
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

            {/* Options */}
            <div className="ml-4 space-y-1.5">
              {prompt.multiple ? (
                // Checkbox for multiple selection
                prompt.options.map((opt, oIdx) => (
                  <div key={oIdx} className="flex items-center gap-2">
                    <Checkbox
                      id={`q${pIdx}-o${oIdx}`}
                      checked={answers[pIdx]?.includes(opt.label)}
                      onCheckedChange={() => toggleOption(pIdx, opt.label)}
                      disabled={loading}
                    />
                    <Label
                      htmlFor={`q${pIdx}-o${oIdx}`}
                      className="text-sm cursor-pointer"
                    >
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && (
                        <span className="text-muted-foreground ml-1">
                          — {opt.description}
                        </span>
                      )}
                    </Label>
                  </div>
                ))
              ) : (
                // Radio for single selection
                <RadioGroup
                  value={answers[pIdx]?.[0] || ''}
                  onValueChange={(val) => {
                    setAnswers((prev) => {
                      const next = [...prev];
                      next[pIdx] = [val];
                      return next;
                    });
                  }}
                >
                  {prompt.options.map((opt, oIdx) => (
                    <div key={oIdx} className="flex items-center gap-2">
                      <RadioGroupItem
                        value={opt.label}
                        id={`q${pIdx}-o${oIdx}`}
                        disabled={loading}
                      />
                      <Label
                        htmlFor={`q${pIdx}-o${oIdx}`}
                        className="text-sm cursor-pointer"
                      >
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="text-muted-foreground ml-1">
                            — {opt.description}
                          </span>
                        )}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              )}

              {/* Custom answer input */}
              <div className="mt-1.5">
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
                  disabled={loading}
                />
              </div>
            </div>
          </div>
        ))}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={dismissQuestion}
            disabled={loading}
          >
            忽略
          </Button>
          <Button
            size="sm"
            onClick={submitAnswers}
            disabled={loading}
          >
            提交回答
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
