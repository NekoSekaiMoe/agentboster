import { ofetch } from 'ofetch';
import type { LocalScorerConfig } from '../../config/types';
import type { IScoringProvider, ScoreRequest, ScoreResponse } from './types';

const SCORING_PROMPT = `You are a security evaluation assistant. Evaluate the following action and classify it according to these three levels:

- **safe**: Routine, low-risk operations (e.g., reading files, listing directories, running tests, git status)
- **inspect**: Potentially risky operations that need review (e.g., installing packages, modifying configs, network requests)
- **unsafe**: Dangerous operations that could cause serious harm (e.g., rm -rf /, mkfs, dd, accessing /etc/shadow, destructive commands)

Evaluate the action and respond ONLY with a JSON object in this exact format:
{"level": "safe|inspect|unsafe", "score": 0-100, "reasoning": "brief explanation", "requiresConfirmation": true|false}

Consider these risk factors:
- File system modifications outside working directory
- System-level commands (mkfs, fdisk, dd)
- Permission changes (chmod 777, chown)
- Network operations to unknown hosts
- Package installations
- Database operations
- Process management (kill, pkill)`;

export class LocalScorerProvider implements IScoringProvider {
  readonly name: string;
  readonly type = 'local' as const;
  private config: LocalScorerConfig;

  constructor(config: LocalScorerConfig) {
    this.config = config;
    this.name = `local:${config.model}`;
  }

  async evaluate(req: ScoreRequest): Promise<ScoreResponse> {
    const userPrompt = this.buildUserPrompt(req);

    try {
      const response = await ofetch<{
        choices: Array<{ message: { content: string } }>;
      }>(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: this.config.model,
          messages: [
            { role: 'system', content: SCORING_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 200,
        },
        timeout: this.config.timeout,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        return this.fallbackResponse('No response from scoring model');
      }

      return this.parseResponse(content);
    } catch (error) {
      return this.fallbackResponse(
        `Scoring error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async evaluateBatch(reqs: ScoreRequest[]): Promise<ScoreResponse[]> {
    const results: ScoreResponse[] = [];
    for (const req of reqs) {
      results.push(await this.evaluate(req));
    }
    return results;
  }

  private buildUserPrompt(req: ScoreRequest): string {
    const parts = [
      `Action: ${req.action}`,
      req.command ? `Command: ${req.command}` : null,
      `Working Directory: ${req.context.workingDirectory}`,
      `Sandbox Type: ${req.context.sandboxType}`,
      `User: ${req.context.userId}`,
      `Agent: ${req.context.agentId}`,
      `Task: ${req.context.taskDescription}`,
    ].filter(Boolean);
    return parts.join('\n');
  }

  private parseResponse(content: string): ScoreResponse {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.fallbackResponse('Invalid JSON response');
      }
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ScoreResponse>;
      return {
        level: parsed.level ?? 'inspect',
        score:
          typeof parsed.score === 'number'
            ? Math.min(100, Math.max(0, parsed.score))
            : 50,
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        requiresConfirmation: parsed.requiresConfirmation ?? true,
      };
    } catch {
      return this.fallbackResponse('Failed to parse scoring response');
    }
  }

  private fallbackResponse(reasoning: string): ScoreResponse {
    return {
      level: 'inspect',
      score: 50,
      reasoning,
      requiresConfirmation: true,
    };
  }
}
