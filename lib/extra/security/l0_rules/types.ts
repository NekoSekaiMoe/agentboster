export interface L0Rule {
  id: string;
  name: string;
  description: string;
  pattern: string;
  patternType: 'regex' | 'glob';
  action: 'allow' | 'block' | 'escalate';
  notifyOnBlock: boolean;
  allowTemporaryOverride: boolean;
  overrideWindowSeconds: number;
  priority: number;
  enabled: boolean;
}

export interface L0Result {
  matched: boolean;
  rule: L0Rule | null;
  action: string;
  message: string;
}

export interface IL0RuleEngine {
  evaluate(command: string, workingDirectory: string): Promise<L0Result>;
  addRule(rule: L0Rule): void;
  removeRule(id: string): void;
  reloadRules(): void;
}
