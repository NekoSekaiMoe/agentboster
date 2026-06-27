import { performLogin } from '../../lib/login-core';
import { getActiveDeployment } from '../../lib/config';
import { createApiClient, createStreamFetcher } from '../../lib/api';
import type { TuiHost } from '../tui';

/**
 * Auth controller. Owns the inline `/login` command and the transition
 * out of the `unauthenticated` phase. After a successful login, wires
 * the new deployment into the host's api/stream client holders and
 * flips the phase to `ready`.
 */
export class AuthController {
  constructor(private readonly host: TuiHost) {}

  async handleLoginCommand(line: string): Promise<void> {
    const parts = line.split(/\s+/).slice(1); // drop "/login"
    if (parts.length < 3) {
      this.host.setStatus(
        this.host.theme.styles.error(
          'Usage: /login <url> <username> <password>',
        ),
      );
      return;
    }
    const [url, username, ...rest] = parts;
    const password = rest.join(' ');
    this.host.setStatus(
      this.host.theme.styles.textDim(`Logging in to ${url}…`),
    );

    const result = await performLogin({ baseUrl: url, username, password });
    if (!result.ok) {
      this.host.setStatus(this.host.theme.styles.error(result.error));
      return;
    }

    // Wire the new deployment into the host's holders.
    const active = getActiveDeployment(
      result.config,
      this.host.state.config.defaultDeployment,
    );
    this.host.state.config = result.config;
    this.host.state.deployment = active;
    this.host.apiClient = active ? createApiClient(active.deployment) : null;
    this.host.streamFetch = active
      ? createStreamFetcher(active.deployment)
      : null;
    this.host.state.phase = { kind: 'ready' };
    this.host.render();

    const expiry = new Date(result.deployment.expiresAt).toLocaleString();
    this.host.setStatus(
      this.host.theme.styles.success(
        `Logged in as ${result.deployment.username} on ${result.deployment.baseUrl} (expires ${expiry}).`,
      ),
    );
  }
}
