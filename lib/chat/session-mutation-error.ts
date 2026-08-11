/**
 * Map a SessionMutationResult error code (see app/(chat)/actions.ts) to a
 * localized toast message. Those server actions RETURN structured failures
 * instead of throwing, so every caller must check `result.success` and
 * route the code through this mapping — never surface raw `error.message`
 * (Next.js redacts it in production anyway).
 *
 * Mirrors the mapping in
 * components/config/sections/workspace-sessions-table.tsx; shared here so
 * the sidebar/chat call sites use the same localized strings.
 */

import type { TranslationKey, TranslationValues } from '@/lib/i18n';

export type SessionMutationErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unknown';

type TranslateFn = (key: TranslationKey, values?: TranslationValues) => string;

export function sessionMutationErrorMessage(
  t: TranslateFn,
  code: SessionMutationErrorCode,
  fallback: string,
): string {
  switch (code) {
    case 'forbidden':
      return t('workspace.detail.sessionErrorForbidden');
    case 'not_found':
      return t('workspace.detail.sessionErrorNotFound');
    case 'invalid_input':
      return t('workspace.detail.sessionErrorInvalidInput');
    default:
      return fallback;
  }
}
