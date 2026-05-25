import type { IScoringProvider, ScoreRequest } from '../scorer/types';
import { getCachedL1Result, setCachedL1Result } from './cache';

export interface L1Result {
  level: 'safe' | 'inspect' | 'unsafe' | 'critical';
  score: number;
  reasoning: string;
  escalated: boolean;
  fromCache?: boolean;
}

export interface IL1Scorer {
  evaluate(req: ScoreRequest): Promise<L1Result>;
}

export const DEFAULT_ESCALATION_THRESHOLD = 70;
export const UNSAFE_DIRECT_REJECT_THRESHOLD = 95;

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
    const cached = getCachedL1Result(req);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const response = await this.provider.evaluate(req);

    let level: L1Result['level'] = response.level;
    let escalated = response.score >= this.escalationThreshold;

    if (response.score >= UNSAFE_DIRECT_REJECT_THRESHOLD) {
      level = 'critical';
      escalated = false;
    }

    const result: L1Result = {
      level,
      score: response.score,
      reasoning: response.reasoning,
      escalated,
    };

    setCachedL1Result(req, result);

    return result;
  }
}
