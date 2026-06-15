import { randomInt } from 'node:crypto';
import { pairImAccount, unpairImAccount } from '@/lib/core/db/im-accounts';
import { del, get, set } from '@/lib/core/kv';
import { getConfig, patchConfig } from '@/lib/core/kv/config';
import { ADAPTER_NAMES, type AdapterName } from '@/types/config/channels';

const PAIR_CODE_TTL = 900; // 15 minutes
const PAIR_CODE_PREFIX = 'pair:code:';
const PAIR_BOUND_PREFIX = 'pair:bound:';

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

export async function generatePairCode(
  adapter: AdapterName,
  clawlessUserId: string,
): Promise<{ code: string; expiresIn: number }> {
  if (!ADAPTER_NAMES.includes(adapter)) {
    throw new Error(`Invalid adapter: ${adapter}`);
  }
  if (!clawlessUserId) {
    throw new Error('clawlessUserId is required to generate a pair code.');
  }
  const code = generateCode();
  await set(
    `${PAIR_CODE_PREFIX}${code}`,
    { adapter, userId: clawlessUserId },
    { ex: PAIR_CODE_TTL },
  );
  return { code, expiresIn: PAIR_CODE_TTL };
}

export async function executePairCommand(
  args: string,
  adapter: AdapterName,
  userId: string | null,
  userName?: string | null,
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

  // Upstash Redis auto-deserializes JSON values, so `raw` may already be an
  // object. Handle both object and string forms for robustness.
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
    adapter?: string;
    userId?: string;
  };

  if (!parsed || typeof parsed !== 'object') {
    return 'Invalid pair code data.';
  }

  if (parsed.adapter !== adapter) {
    return `This code is for adapter "${parsed.adapter}", but you're on "${adapter}".`;
  }

  const clawlessUserId = parsed.userId;
  if (!clawlessUserId) {
    await del(codeKey);
    return 'This pair code was generated without a bound user. Please regenerate it from the Web UI after signing in.';
  }

  const config = await getConfig();
  const adapterConfig = config.channels?.[adapter];
  const currentIds = adapterConfig?.allowed_author_ids ?? [];

  if (!currentIds.includes(userId)) {
    await patchConfig({
      channels: {
        ...config.channels,
        [adapter]: {
          ...adapterConfig,
          allowed_author_ids: [...currentIds, userId],
        },
      },
    });
  }

  await pairImAccount({
    clawlessUserId,
    adapter,
    imUserId: userId,
    imUserName: userName ?? null,
  });

  await del(codeKey);
  await set(boundKey, '1');

  return `Paired successfully! Your ${adapter} account (${userId}) is now bound to your ClawLess account.`;
}

export async function executeUnpairCommand(
  adapter: AdapterName,
  userId: string | null,
): Promise<string> {
  if (!userId) {
    return 'Cannot unpair: user ID not available.';
  }

  const removed = await unpairImAccount({ adapter, imUserId: userId });
  if (!removed) {
    return 'No active pairing found for your account.';
  }

  await del(`${PAIR_BOUND_PREFIX}${adapter}:${userId}`);

  const config = await getConfig();
  const adapterConfig = config.channels?.[adapter];
  const currentIds = adapterConfig?.allowed_author_ids ?? [];
  if (currentIds.includes(userId)) {
    await patchConfig({
      channels: {
        ...config.channels,
        [adapter]: {
          ...adapterConfig,
          allowed_author_ids: currentIds.filter((id) => id !== userId),
        },
      },
    });
  }

  return `Unpaired. Your ${adapter} account (${userId}) is no longer bound. You will lose access on next message unless re-paired.`;
}
