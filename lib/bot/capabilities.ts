import type { AdapterName } from '@/types/config/channels';

export interface BotCapabilities {
  delete: boolean;
  edit: boolean;
  reaction: boolean;
  /** Whether the adapter renders interactive L2 buttons (vs. plain-text prompt). */
  richButton: boolean;
  /**
   * Whether the adapter renders L2 decisions as clickable URL links in
   * the message body (markdown). Used when the platform has no
   * callback button API or it's gated behind per-bot permission
   * approval (QQ). The link points at the public /api/l2/<id>/<action>
   * endpoint with an HMAC signature in the query string.
   */
  linkButton: boolean;
}

const CAPABILITY_MAP: Partial<Record<AdapterName, BotCapabilities>> = {
  telegram: {
    delete: true,
    edit: true,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
  discord: {
    delete: true,
    edit: true,
    reaction: true,
    richButton: true,
    linkButton: false,
  },
  slack: {
    delete: true,
    edit: true,
    reaction: true,
    richButton: true,
    linkButton: false,
  },
  teams: {
    delete: true,
    edit: true,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
  gchat: {
    delete: false,
    edit: false,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
  feishu: {
    delete: true,
    edit: true,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
  // QQ has no usable callback button API without per-bot permission
  // approval from Tencent. L2 decisions fall back to URL links
  // (capabilities.linkButton = true) which any IM client can open.
  qq: {
    delete: true,
    edit: true,
    reaction: false,
    richButton: false,
    linkButton: true,
  },
  wecom: {
    delete: false,
    edit: false,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
  dingtalk: {
    delete: false,
    edit: false,
    reaction: false,
    richButton: true,
    linkButton: false,
  },
};

export function getBotCapabilities(adapter: string): BotCapabilities {
  return (
    CAPABILITY_MAP[adapter as AdapterName] ?? {
      delete: false,
      edit: false,
      reaction: false,
      richButton: false,
      linkButton: false,
    }
  );
}
