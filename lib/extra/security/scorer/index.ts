import type { LocalScorerConfig, RemoteScorerConfig } from '../../config/types';
import { LocalScorerProvider } from './local';
import { RemoteScorerProvider } from './remote';
import type { IScoringProvider } from './types';

export type { ScoreRequest, ScoreResponse, IScoringProvider } from './types';
export { LocalScorerProvider } from './local';
export { RemoteScorerProvider } from './remote';

export function createScorerProvider(
  config: (LocalScorerConfig | RemoteScorerConfig) & {
    failurePolicy?: 'open' | 'closed';
  },
): IScoringProvider {
  if ('apiKey' in config) {
    return new RemoteScorerProvider(config);
  }
  return new LocalScorerProvider(config);
}
