'use client';

import { ofetch } from 'ofetch';
import { useCallback, useEffect, useState } from 'react';

import { AskQuestionCard } from './ask-question-card';

interface QuestionPrompt {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
}

interface QuestionRequest {
  id: string;
  session_id: string;
  prompts: QuestionPrompt[];
  status: string;
  created_at: string;
}

/**
 * QuestionsList polls for and displays pending questions from the agent.
 * Similar to opencode's GET /question list.
 */
export function QuestionsList() {
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQuestions = useCallback(async () => {
    try {
      const resp = await ofetch<{ success: boolean; data: QuestionRequest[] }>(
        '/api/agentd/v1/questions',
      );
      if (resp.success) {
        setQuestions(resp.data.filter((q) => q.status === 'sent' || q.status === 'pending'));
      }
    } catch {
      // Silently fail — questions are optional
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuestions();
    const interval = setInterval(fetchQuestions, 5000);
    return () => clearInterval(interval);
  }, [fetchQuestions]);

  const handleResolved = useCallback((questionId: string) => {
    setQuestions((prev) => prev.filter((q) => q.id !== questionId));
  }, []);

  if (loading) return null;
  if (questions.length === 0) return null;

  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <AskQuestionCard
          key={q.id}
          request={q}
          onResolved={handleResolved}
        />
      ))}
    </div>
  );
}
