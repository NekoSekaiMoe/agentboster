import type { IScoringProvider, ScoreRequest } from '../scorer/types';

export interface L1Result {
  level: 'safe' | 'inspect' | 'unsafe';
  score: number;
  reasoning: string;
  escalated: boolean;
}

export interface IL1Scorer {
  evaluate(req: ScoreRequest): Promise<L1Result>;
}

const DEFAULT_ESCALATION_THRESHOLD = 70;

export class L1Scorer implements IL1Scorer {
  private provider: IScoringProvider;
  private escalationThreshold: number;

  constructor(
    provider: IScoringProvider,
    escalationThreshold: number = DEFAULT_ESCALATION_THRESHOLD,
  ) {
    this.provider = provider;
    this.escalationThreshold = escalationThreshold;
  }

  async evaluate(req: ScoreRequest): Promise<L1Result> {
    const response = await this.provider.evaluate(req);

    return {
      level: response.level,
      score: response.score,
      reasoning: response.reasoning,
      escalated: response.score >= this.escalationThreshold,
    };
  }
}
