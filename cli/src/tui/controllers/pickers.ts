import { type SelectItem, SelectList, type TUI } from '@earendil-works/pi-tui';
import { buildSelectListTheme } from '../theme/pi-tui-theme';
import { currentTheme } from '../theme';
import type { ListModelsResponse, ListSessionsResponse } from '../../lib/api';
import type { TuiHost } from '../tui';

/**
 * Pickers controller. Owns the Ctrl+P (session) and Ctrl+L (model)
 * overlays. Both fetch their list from the /api/cli/* REST routes
 * and show a SelectList via tui.showOverlay(). On select, mutates
 * TUIState (sessionId for sessions, model for models).
 */
export class PickersController {
  constructor(private readonly host: TuiHost) {}

  showSessionPicker(): void {
    if (this.host.state.phase.kind === 'streaming') {
      this.host.setStatus(
        this.host.theme.styles.warning('Wait for the turn to finish.'),
      );
      return;
    }
    if (!this.host.apiClient) {
      this.host.setStatus(this.host.theme.styles.error('Not logged in.'));
      return;
    }
    this.host.setStatus(this.host.theme.styles.textDim('Loading sessions…'));
    const client = this.host.apiClient;

    void (async () => {
      let res: ListSessionsResponse;
      try {
        res = await client<ListSessionsResponse>('/api/cli/sessions?limit=50');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.host.setStatus(this.host.theme.styles.error(`Failed: ${msg}`));
        return;
      }
      if (!res.ok || res.sessions.length === 0) {
        this.host.setStatus(
          this.host.theme.styles.textDim('No sessions on this machine.'),
        );
        return;
      }
      const items: SelectItem[] = res.sessions.map((s) => ({
        value: s.id,
        label: s.title?.trim() || '(untitled)',
        description: `${s.channel} · ${s.id.slice(0, 8)}… · ${new Date(s.updatedAt).toLocaleString()}`,
      }));
      this.mountList(items, (item) => {
        this.host.state.sessionId = item.value;
        this.host.state.turns = [];
        this.host.state.streamingText = '';
        this.host.render();
        this.host.setStatus(
          this.host.theme.styles.textDim(
            `switched to ${item.value.slice(0, 8)}… — ask a question to continue`,
          ),
        );
      });
    })();
  }

  showModelPicker(): void {
    if (!this.host.apiClient) {
      this.host.setStatus(this.host.theme.styles.error('Not logged in.'));
      return;
    }
    this.host.setStatus(this.host.theme.styles.textDim('Loading models…'));
    const client = this.host.apiClient;

    void (async () => {
      let res: ListModelsResponse;
      try {
        res = await client<ListModelsResponse>('/api/cli/models');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.host.setStatus(this.host.theme.styles.error(`Failed: ${msg}`));
        return;
      }
      if (!res.ok || res.models.length === 0) {
        this.host.setStatus(
          this.host.theme.styles.textDim(
            'No model catalog; pass --model <id> at startup.',
          ),
        );
        return;
      }
      const items: SelectItem[] = res.models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.id === res.defaultModel ? 'server default' : '',
      }));
      this.mountList(items, (item) => {
        this.host.state.model = item.value;
        this.host.setStatus(
          this.host.theme.styles.textDim(`model: ${item.value}`),
        );
      });
    })();
  }

  private mountList(
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
  ): void {
    const styles = currentTheme().styles;
    const theme = buildSelectListTheme(styles);
    const list = new SelectList(items, 10, theme);
    list.onSelect = (item: SelectItem) => {
      this.host.tui.hideOverlay();
      onSelect(item);
    };
    list.onCancel = () => {
      this.host.tui.hideOverlay();
      this.host.setStatus('');
    };
    this.host.tui.showOverlay(list, {
      width: '70%',
      maxHeight: 15,
      anchor: 'top-center',
    });
    this.host.setStatus('');
  }
}

// Type-only re-export so callers can `import type { TUI }`.
export type { TUI };
