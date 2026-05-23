export interface ScoreRequest {
  action: string;
  command?: string;
  context: {
    workingDirectory: string;
    sandboxType: string;
    userId: string;
    agentId: string;
    taskDescription: string;
  };
}

export interface ScoreResponse {
  level: 'safe' | 'inspect' | 'unsafe';
  score: number;
  reasoning: string;
  requiresConfirmation: boolean;
}

export interface IScoringProvider {
  evaluate(req: ScoreRequest): Promise<ScoreResponse>;
  evaluateBatch(reqs: ScoreRequest[]): Promise<ScoreResponse[]>;
  readonly name: string;
  readonly type: 'local' | 'remote';
}
