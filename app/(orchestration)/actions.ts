'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthAccess } from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import {
  addPlanItem,
  archivePlan,
  assertCanAccessPlan,
  createPlan,
  getPlan,
  listPlansBySession,
  markPlanSubmitted,
  removePlanItem,
  synthesizePlanInstruction,
  updatePlan,
  updatePlanItem,
} from '@/lib/core/db/agent-orchestration-plans';
import { cookies } from 'next/headers';

/**
 * Server actions for the Team Mode II manual planning entry.
 *
 * The plan is user-authored in the UI; submitting it synthesizes a
 * natural-language instruction and posts it into the session as a user
 * message, so the main agent fans it out via its existing subAgent tool.
 *
 * All actions enforce session ownership — a user can only create / mutate
 * plans for sessions they own.
 */

async function requireSessionOwned(sessionId: string) {
  const access = await requireAuthAccess(await cookies());
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.userId !== access.session.userId) {
    throw new Error('Not allowed to modify this session');
  }
  return { access, session };
}

export async function createPlanAction(input: {
  sessionId: string;
  title: string;
  description?: string;
}) {
  await requireSessionOwned(input.sessionId);
  const plan = await createPlan(input);
  revalidatePath(`/chat/${input.sessionId}/orchestration`);
  return plan;
}

export async function listPlansAction(sessionId: string) {
  await requireSessionOwned(sessionId);
  return listPlansBySession(sessionId);
}

export async function getPlanAction(planId: string) {
  const plan = await getPlan(planId);
  if (!plan) return null;
  await requireSessionOwned(plan.sessionId);
  return plan;
}

export async function addPlanItemAction(input: {
  planId: string;
  agentName: string;
  task: string;
  dependsOn?: string[];
  order?: number;
}) {
  const plan = await getPlan(input.planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  const item = await addPlanItem(input);
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
  return item;
}

export async function updatePlanItemAction(
  itemId: string,
  patch: Parameters<typeof updatePlanItem>[2],
  planId: string,
) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  await updatePlanItem(itemId, planId, patch);
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
}

export async function removePlanItemAction(itemId: string, planId: string) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  await removePlanItem(itemId, planId);
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
}

export async function archivePlanAction(planId: string) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  await archivePlan(planId);
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
}

/**
 * Finalize a plan: synthesize the fan-out instruction text and mark the plan
 * as submitted. Does NOT post the message itself — the caller (chat UI) takes
 * the returned `instruction` and sends it via the normal chat send path, so
 * submission looks identical to the user typing the message. This keeps the
 * server action free of cross-route HTTP calls and lets the chat UI own the
 * message-id / streaming lifecycle.
 */
export async function submitPlanAction(planId: string) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  if (plan.items.length === 0) {
    throw new Error('Cannot submit an empty plan');
  }
  const instruction = synthesizePlanInstruction(plan);
  // Mark submitted but leave submittedMessageId null — the chat UI fills it
  // in once it has actually sent the message. For now this status is enough
  // to move the plan out of the 'draft' list.
  await markPlanSubmitted(planId, '');
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
  return { instruction, sessionId: plan.sessionId };
}

export async function updatePlanAction(
  planId: string,
  patch: Parameters<typeof updatePlan>[1],
) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  await requireSessionOwned(plan.sessionId);
  await assertCanAccessPlan(planId, plan.sessionId);
  await updatePlan(planId, patch);
  revalidatePath(`/chat/${plan.sessionId}/orchestration`);
}
