import type { AdapterName } from '@/types/config/channels';

export interface BotCapabilities {
  delete: boolean;
  edit: boolean;
  reaction: boolean;
}

const CAPABILITY_MAP: Partial<Record<AdapterName, BotCapabilities>> = {
  telegram: { delete: true, edit: true, reaction: false },
  discord: { delete: true, edit: true, reaction: true },
  slack: { delete: true, edit: true, reaction: true },
  teams: { delete: true, edit: true, reaction: false },
  gchat: { delete: false, edit: true, reaction: false },
  feishu: { delete: false, edit: false, reaction: false },
  qq: { delete: false, edit: false, reaction: false },
};

export function getBotCapabilities(adapter: string): BotCapabilities {
  return (
    CAPABILITY_MAP[adapter as AdapterName] ?? {
      delete: false,
      edit: false,
      reaction: false,
    }
  );
}
