import { L0RuleEngine } from './l0_rules/engine';
import type { IL0RuleEngine } from './l0_rules/types';
import { L1Scorer } from './l1_scorer';
import type { IL1Scorer, L1Result } from './l1_scorer';
import { L2AuthManager } from './l2_auth/manager';
import type { IL2AuthManager, L2AuthRequest } from './l2_auth/types';
import type { IScoringProvider, ScoreRequest } from './scorer/types';

export interface GatekeeperResult {
  authorized: boolean;
  level: 'L0' | 'L1' | 'L2';
  details:
    | {
        matched: boolean;
        rule: { id: string; name: string; action: string } | null;
        message: string;
      }
    | L1Result
    | L2AuthRequest;
  notificationSent: boolean;
}

export interface ISecurityGatekeeper {
  evaluate(req: ScoreRequest): Promise<GatekeeperResult>;
  handleL2Response(resp: {
    requestId: string;
    authorized: boolean;
    window?: string;
    rejectedReason?: string;
  }): Promise<void>;
}

export interface GatekeeperOptions {
  l0RulesPath?: string;
  escalationThreshold?: number;
}

export class SecurityGatekeeper implements ISecurityGatekeeper {
  private l0: IL0RuleEngine;
  private l1: IL1Scorer;
  private l2: IL2AuthManager;

  constructor(scorerProvider: IScoringProvider, options?: GatekeeperOptions) {
    this.l0 = new L0RuleEngine();
    this.l1 = new L1Scorer(scorerProvider, options?.escalationThreshold);
    this.l2 = new L2AuthManager();
  }

  async evaluate(req: ScoreRequest): Promise<GatekeeperResult> {
    const l0Result = await this.l0.evaluate(
      req.command ?? req.action,
      req.context.workingDirectory,
    );

    if (l0Result.matched && l0Result.action === 'block') {
      return {
        authorized: false,
        level: 'L0',
        details: l0Result,
        notificationSent: l0Result.rule?.notifyOnBlock ?? false,
      };
    }

    if (l0Result.matched && l0Result.action === 'allow') {
      return {
        authorized: true,
        level: 'L0',
        details: l0Result,
        notificationSent: false,
      };
    }

    if (l0Result.matched && l0Result.action === 'escalate') {
      if (this.l2.isAuthorized(req.action, 'once')) {
        return {
          authorized: true,
          level: 'L0',
          details: l0Result,
          notificationSent: false,
        };
      }
    }

    const l1Result = await this.l1.evaluate(req);

    if (l1Result.level === 'unsafe') {
      return {
        authorized: false,
        level: 'L1',
        details: l1Result,
        notificationSent: true,
      };
    }

    if (l1Result.level === 'safe' && !l1Result.escalated) {
      return {
        authorized: true,
        level: 'L1',
        details: l1Result,
        notificationSent: false,
      };
    }

    const authRequest: L2AuthRequest = {
      id: crypto.randomUUID(),
      action: req.action,
      risk: {
        level: l1Result.level,
        score: l1Result.score,
        reasoning: l1Result.reasoning,
      },
      timestamp: Date.now(),
      channelId: req.context.agentId,
      userId: req.context.userId,
    };

    if (this.l2.isAuthorized(req.action, 'once')) {
      return {
        authorized: true,
        level: 'L2',
        details: authRequest,
        notificationSent: false,
      };
    }

    await this.l2.requestAuthorization(authRequest);

    return {
      authorized: false,
      level: 'L2',
      details: authRequest,
      notificationSent: true,
    };
  }

  async handleL2Response(resp: {
    requestId: string;
    authorized: boolean;
    window?: string;
    rejectedReason?: string;
  }): Promise<void> {
    await this.l2.handleResponse({
      requestId: resp.requestId,
      authorized: resp.authorized,
      window: resp.window as L2AuthRequest extends { window?: infer W }
        ? W
        : never,
      rejectedReason: resp.rejectedReason,
    });
  }

  getL2AuthManager(): IL2AuthManager {
    return this.l2;
  }

  getL0RuleEngine(): IL0RuleEngine {
    return this.l0 as L0RuleEngine;
  }
}
