/**
 * agentboster CLI 配置目录定位。
 *
 * agentboster CLI 由 `@agentboster-cli/core` 发布，其 `package.json` 中
 * `piConfig.configDir = ".agentboster"`，因此 agent 全局配置统一存放在
 * `~/.agentboster/agent/` 下（参见
 * subpackage/cli/packages/coding-agent/src/config.ts 的 CONFIG_DIR_NAME）。
 *
 * 历史版本（PiDeck fork）按 `~/.pi/agent/` 读写；本模块集中提供路径，
 * 避免散落的字符串字面量在升级时漏改。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** agentboster CLI 在用户家目录下的配置根，例如 ~/.agentboster/agent */
export const AGENTBOSTER_AGENT_DIR: string = join(homedir(), ".agentboster", "agent");

/** 用户级扩展目录：~/.agentboster/agent/extensions */
export const AGENTBOSTER_EXTENSIONS_DIR: string = join(AGENTBOSTER_AGENT_DIR, "extensions");

/** 用户级 skills 目录：~/.agentboster/agent/skills */
export const AGENTBOSTER_SKILLS_DIR: string = join(AGENTBOSTER_AGENT_DIR, "skills");

/** 用户级 sessions 目录：~/.agentboster/agent/sessions */
export const AGENTBOSTER_SESSIONS_DIR: string = join(AGENTBOSTER_AGENT_DIR, "sessions");

/** agentboster 自身维护的全局 settings.json：~/.agentboster/agent/settings.json */
export const AGENTBOSTER_SETTINGS_FILE: string = join(AGENTBOSTER_AGENT_DIR, "settings.json");
