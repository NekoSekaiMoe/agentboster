import { createLogger } from '@/lib/utils/logger';
import type {
  HookContext,
  HookHandler,
  HookNode,
  HookPayloads,
  HookRegistration,
} from './types';

const logger = createLogger('workflow.agent.hooks');

export class HookRegistry {
  private hooks: Map<HookNode, HookRegistration[]> = new Map();

  register<T extends HookNode>(
    registration: HookRegistration<HookPayloads[T]>,
  ): () => void {
    const existing = this.hooks.get(registration.node) || [];
    existing.push(registration as HookRegistration);
    existing.sort((a, b) => b.priority - a.priority);
    this.hooks.set(registration.node, existing);

    return () => {
      const current = this.hooks.get(registration.node) || [];
      this.hooks.set(
        registration.node,
        current.filter((h) => h.id !== registration.id),
      );
    };
  }

  async executeBefore<T extends HookNode>(
    node: T,
    payload: HookPayloads[T],
    context: HookContext,
  ): Promise<HookPayloads[T]> {
    const registrations = this.hooks.get(node) || [];
    let current = payload;

    for (const reg of registrations) {
      try {
        const handler = reg.handler as HookHandler<HookPayloads[T]>;
        const result = await handler(current, context);
        if (result !== undefined) {
          current = result;
        }
      } catch (error) {
        logger.error('hook:before failed', {
          node,
          hookId: reg.id,
          sessionId: context.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return current;
  }

  async executeAfter<T extends HookNode>(
    node: T,
    payload: HookPayloads[T],
    context: HookContext,
  ): Promise<void> {
    const registrations = this.hooks.get(node) || [];
    const promises: Promise<void>[] = [];

    for (const reg of registrations) {
      promises.push(
        (async () => {
          try {
            const handler = reg.handler as HookHandler<HookPayloads[T]>;
            await handler(payload, context);
          } catch (error) {
            logger.error('hook:after failed', {
              node,
              hookId: reg.id,
              sessionId: context.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })(),
      );
    }

    await Promise.all(promises);
  }
}

export const hookRegistry = new HookRegistry();

export function registerHook<T extends HookNode>(
  registration: HookRegistration<HookPayloads[T]>,
): () => void {
  return hookRegistry.register(registration);
}
