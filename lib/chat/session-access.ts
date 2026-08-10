/**
 * Shared-session access gate (multi-member workspaces).
 *
 * Three grant levels, ordered by privilege:
 *
 *   'owner'  — the session creator (sessions.user_id match). Full access:
 *              read message content + manage (rename/pin/delete/model/
 *              runtime) + change session visibility.
 *   'shared' — a member of the session's PUBLIC workspace (canAccess) on a
 *              session with visibility='shared'. Read + manage, like the
 *              owner, but cannot change visibility or delete the workspace.
 *   'manage' — metadata management ONLY (list/rename/pin/delete/model/
 *              runtime control) WITHOUT message-content read. Granted to:
 *                - the workspace owner / an admin managing the workspace,
 *                  for OTHER members' private sessions in it;
 *                - global admins on any session they don't own.
 *              Rationale (product decision): a private session's content is
 *              visible to its creator only — admins and workspace owners
 *              can curate the list but never read the conversation.
 *
 * Read gates (chat page, message/tool-result routes, orchestration view)
 * must use `assertCanReadSession`; management gates use
 * `assertCanManageSharedSession`.
 *
 * Every check is fail-closed: any resolution error (DB hiccup, unknown
 * workspace) denies access rather than silently opening the session.
 */

import { AuthError, type AuthAccess } from '@/lib/auth/access';
import { resolveWorkspaceAccess } from '@/lib/core/db/agentd';

/** Minimal shape both ChatSession (DAL) and SessionRecord (chat) satisfy. */
export interface SessionAccessTarget {
  id: string;
  userId?: string | null;
  workspaceId?: string | null;
  /** Session visibility inside a public workspace (see schema/chat.ts). */
  visibility?: string | null;
}

export type SessionGrant = 'owner' | 'shared' | 'manage';

/** Whether the grant includes reading message content. */
export function sessionGrantCanRead(grant: SessionGrant): boolean {
  return grant === 'owner' || grant === 'shared';
}

/**
 * Resolve the actor's grant on a session, or null when they have no
 * business with it at all (invisible — private session in a workspace
 * they can't manage, foreign global session, …).
 */
export async function resolveSessionGrant(
  access: AuthAccess,
  session: SessionAccessTarget,
): Promise<SessionGrant | null> {
  const actorUserId = access.session.userId;

  // The creator always has full access, even if the session's workspace
  // has since been archived or converted back to private.
  if (session.userId && session.userId === actorUserId) {
    return 'owner';
  }

  if (session.workspaceId) {
    try {
      const wsAccess = await resolveWorkspaceAccess(session.workspaceId, {
        userId: actorUserId,
        roles: access.user.roles,
      });
      if (!wsAccess) return access.isAdmin ? 'manage' : null;
      // Shared sessions in an accessible public workspace: full member
      // access. Checked FIRST so a workspace manager keeps read access on
      // shared sessions (canManage ⇒ canAccess).
      if (session.visibility === 'shared' && wsAccess.canAccess) {
        return 'shared';
      }
      // Workspace owner/admin: curate members' private sessions without
      // reading them.
      if (wsAccess.canManage) return 'manage';
      return access.isAdmin ? 'manage' : null;
    } catch {
      // Fail closed on any resolution error.
      return null;
    }
  }

  // Global-scope session (no workspace): owner (handled above) or admin.
  return access.isAdmin ? 'manage' : null;
}

/**
 * Assert the actor may MANAGE the session (any grant level). Throws 403
 * AuthError otherwise. Returns the grant so callers can pick owner-only
 * DB variants (defense in depth) or further restrict (e.g. visibility
 * changes require grant === 'owner').
 */
export async function assertCanManageSharedSession(
  access: AuthAccess,
  session: SessionAccessTarget,
): Promise<SessionGrant> {
  const grant = await resolveSessionGrant(access, session);
  if (!grant) {
    throw new AuthError('Forbidden', 403);
  }
  return grant;
}

/**
 * Assert the actor may READ the session's message content. 'manage'
 * grants (admins / workspace managers looking at private sessions) are
 * REJECTED here — they curate metadata only.
 */
export async function assertCanReadSession(
  access: AuthAccess,
  session: SessionAccessTarget,
): Promise<SessionGrant> {
  const grant = await assertCanManageSharedSession(access, session);
  if (!sessionGrantCanRead(grant)) {
    throw new AuthError('Forbidden', 403);
  }
  return grant;
}
