import { del, get, set } from '@/lib/core/kv';
import { getConfig, patchConfig } from '@/lib/core/kv/config';
import { ADAPTER_NAMES, type AdapterName } from '@/types/config/channels';

const PAIR_CODE_TTL = 900; // 15 minutes
const PAIR_CODE_PREFIX = 'pair:code:';
const PAIR_BOUND_PREFIX = 'pair:bound:';

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function generatePairCode(
  adapter: AdapterName,
): Promise<{ code: string; expiresIn: number }> {
  if (!ADAPTER_NAMES.includes(adapter)) {
    throw new Error(`Invalid adapter: ${adapter}`);
  }
  const code = generateCode();
  await set(`${PAIR_CODE_PREFIX}${code}`, JSON.stringify({ adapter }), {
    ex: PAIR_CODE_TTL,
  });
  return { code, expiresIn: PAIR_CODE_TTL };
}

export async function executePairCommand(
  args: string,
  adapter: AdapterName,
  userId: string | null,
): Promise<string> {
  const trimmed = args.trim();

  if (!trimmed) {
    return 'Usage: /pair <code>';
  }

  if (!userId) {
    return 'Cannot pair: user ID not available.';
  }

  const boundKey = `${PAIR_BOUND_PREFIX}${adapter}:${userId}`;
  const existing = await get(boundKey);
  if (existing) {
    return 'Already paired. No action needed.';
  }

  const codeKey = `${PAIR_CODE_PREFIX}${trimmed}`;
  const raw = await get(codeKey);
  if (!raw) {
    return 'Invalid or expired pair code. Generate a new one in the Web UI.';
  }

  let parsed: { adapter: string };
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    return 'Invalid pair code data.';
  }

  if (parsed.adapter !== adapter) {
    return `This code is for adapter "${parsed.adapter}", but you're on "${adapter}".`;
  }

  const config = await getConfig();
  const adapterConfig = config.channels?.[adapter];
  const currentIds = adapterConfig?.allowed_author_ids ?? [];

  if (currentIds.includes(userId)) {
    await del(codeKey);
    await set(boundKey, '1');
    return 'Already in allowed list. Pairing confirmed.';
  }

  await patchConfig({
    channels: {
      ...config.channels,
      [adapter]: {
        ...adapterConfig,
        allowed_author_ids: [...currentIds, userId],
      },
    },
  });

  await del(codeKey);
  await set(boundKey, '1');

  return `Paired successfully! Your user ID (${userId}) has been added to ${adapter} allowed list.`;
}
