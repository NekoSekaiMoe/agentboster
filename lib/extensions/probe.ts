/**
 * Probe a registered CLI extension to verify it's actually invocable.
 *
 * Runs `<command> --version` (or the extension's declared args if it has no
 * --version flag) under the hardened CommandBuilder from batch #2, with a
 * short timeout. Returns the first line of stdout (the version string) on
 * success, or a structured error explaining what went wrong (binary not on
 * PATH, missing auth env, non-zero exit, timeout).
 *
 * This is the AgentBoster equivalent of AionHub's "test connection" step —
 * a cheap, side-effect-free check that the user's registration is real
 * before any task is dispatched to the extension.
 */
import { createLogger } from '@/lib/utils/logger';
import {
  type CliExtensionManifest,
  missingAuthEnv,
  resolveInvocation,
} from './manifest';

const logger = createLogger('extensions.probe');
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type ProbeStatus =
  | 'ok'
  | 'not_found'
  | 'missing_auth'
  | 'non_zero_exit'
  | 'timeout'
  | 'error';

export interface ProbeResult {
  status: ProbeStatus;
  /** First line of stdout when status === 'ok' (typically the version). */
  version?: string;
  /** Human-readable detail suitable for surfacing in the UI. */
  detail: string;
  /** Missing env var names when status === 'missing_auth'. */
  missingEnv?: string[];
  /** Exit code when status === 'non_zero_exit'. */
  exitCode?: number;
}

/**
 * Probe one extension. `spawn` is injected so tests can stub the subprocess
 * without pulling exec into a unit test. In production the caller passes
 * the real spawn function from node:child_process (dynamic import keeps the
 * workflow bundler happy — see AGENTS.md node:* rule).
 */
export async function probeExtension(
  ext: CliExtensionManifest,
  env: Record<string, string | undefined>,
  spawn: (input: {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
    timeoutMs: number;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  // 1. Auth gate — check BEFORE spawning so we don't even try to run a CLI
  //    that's guaranteed to fail with an opaque auth error.
  const missing = missingAuthEnv(ext, env);
  if (missing.length > 0) {
    return {
      status: 'missing_auth',
      detail: `缺少环境变量: ${missing.join(', ')}。请在守护进程环境中设置后再试。`,
      missingEnv: missing,
    };
  }

  // 2. Resolve the invocation.
  const inv = resolveInvocation(ext);
  if (!inv) {
    return {
      status: 'not_found',
      detail: `扩展 ${ext.name} 未声明 cliCommand 或 defaultCliPath`,
    };
  }

  // 3. Spawn `<command> --version` (cheap, side-effect-free). We don't run
  //    the extension's real args here because those might kick off an agent
  //    loop; --version is the canonical "are you there" probe.
  try {
    const result = await spawn({
      command: inv.command,
      args: ['--version', ...(inv.args ?? [])],
      env,
      timeoutMs,
    });
    if (result.exitCode === 0) {
      const version = result.stdout.split('\n')[0]?.trim() || '(empty)';
      return {
        status: 'ok',
        version,
        detail: `${ext.label ?? ext.name}: ${version}`,
      };
    }
    return {
      status: 'non_zero_exit',
      exitCode: result.exitCode ?? undefined,
      detail: `${ext.name} --version 退出码 ${result.exitCode}。stderr: ${result.stderr.slice(0, 200)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT|no such file/i.test(message)) {
      return {
        status: 'not_found',
        detail: `找不到命令 "${inv.command}"。请安装该 CLI 或在 manifest 中设置 defaultCliPath (如 bunx xxx)。`,
      };
    }
    if (/timed out|ETIMEDOUT|cancel/i.test(message)) {
      return {
        status: 'timeout',
        detail: `${ext.name} --version 在 ${timeoutMs}ms 内未响应。`,
      };
    }
    logger.warn('probe:unexpected_error', { ext: ext.name, error: message });
    return {
      status: 'error',
      detail: `探测 ${ext.name} 时发生意外错误: ${message}`,
    };
  }
}
