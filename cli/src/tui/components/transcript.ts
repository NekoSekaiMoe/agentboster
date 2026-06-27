import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { currentTheme } from '../theme';
import { buildMarkdownTheme } from '../theme/pi-tui-theme';
import type { Turn } from '../tui-state';
import { LoginCardComponent } from './login-card';

/**
 * The scrolling transcript area. Holds either:
 *   - the login card (when phase === 'unauthenticated'), or
 *   - turn history + streaming assistant text.
 *
 * The coordinator calls `render(state)` after every state change;
 * this module clears and re-populates the container. We rebuild on
 * every render because pi-tui's differential renderer handles the
 * diffing cheaply, and per-row caching would complicate streaming.
 */
export function buildTranscript(): Container {
  return new Container();
}

export function renderTranscript(
  container: Container,
  state: {
    phase: { kind: string };
    turns: Turn[];
    streamingText: string;
  },
): void {
  const styles = currentTheme().styles;
  const markdownTheme = buildMarkdownTheme(styles);

  container.clear();

  if (state.phase.kind === 'unauthenticated') {
    container.addChild(new LoginCardComponent());
    return;
  }

  for (const turn of state.turns) {
    const prefix =
      turn.role === 'user'
        ? styles.roleUser('you:')
        : styles.roleAssistant('assistant:');
    container.addChild(new Text(prefix, 0, 0));
    container.addChild(new Markdown(turn.text, 1, 1, markdownTheme));
    container.addChild(new Spacer(1));
  }

  if (state.streamingText) {
    container.addChild(new Text(styles.roleAssistant('assistant:'), 0, 0));
    container.addChild(new Markdown(state.streamingText, 1, 1, markdownTheme));
  }
}
