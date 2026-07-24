'use client';

import { Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  addPlanItemAction,
  createPlanAction,
  removePlanItemAction,
  submitPlanAction,
  updatePlanItemAction,
  type listPlansAction,
} from '@/app/(orchestration)/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AgentOrchestrationPlanItem } from '@/lib/core/db/schema';

type PlanListEntry = Awaited<ReturnType<typeof listPlansAction>>[number];
interface PlanWithItems extends PlanListEntry {
  items?: AgentOrchestrationPlanItem[];
}

/**
 * Team Mode II: manual plan editor.
 *
 * Lets the user enumerate subtasks, assign each to a configured agent, and
 * express dependencies. Submitting synthesizes a fan-out instruction and
 * drops it into the chat input (the user reviews and sends it like a normal
 * message, keeping the chat UI the single owner of the send lifecycle).
 *
 * Pure client component; every mutation is a server action. Plan state is
 * re-fetched by the parent on action completion.
 */
export function PlanEditor({
  sessionId,
  plans,
  agents,
}: {
  sessionId: string;
  plans: PlanWithItems[];
  agents: { name: string }[];
}) {
  const [activePlanId, setActivePlanId] = useState<string | null>(
    plans[0]?.planId ?? null,
  );
  const activePlan = plans.find((p) => p.planId === activePlanId) ?? null;

  async function handleCreate() {
    try {
      const plan = await createPlanAction({
        sessionId,
        title: `规划 ${new Date().toLocaleString()}`,
      });
      setActivePlanId(plan.planId);
      toast.success('已创建新规划');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    }
  }

  async function handleAddItem() {
    if (!activePlan) return;
    try {
      await addPlanItemAction({
        planId: activePlan.planId,
        agentName: agents[0]?.name ?? 'default',
        task: '新任务',
      });
      toast.success('已添加任务项');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '添加失败');
    }
  }

  async function handleRemoveItem(itemId: string) {
    if (!activePlan) return;
    try {
      await removePlanItemAction(itemId, activePlan.planId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function handleSubmit() {
    if (!activePlan) return;
    try {
      const result = await submitPlanAction(activePlan.planId);
      // Drop the synthesized instruction into the chat input via a custom
      // event the chat-box listens for. This avoids a direct chat-send
      // dependency here.
      window.dispatchEvent(
        new CustomEvent('agentboster:plan-instruction', {
          detail: { sessionId: result.sessionId, text: result.instruction },
        }),
      );
      toast.success('已生成指令，请在聊天框确认发送');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败');
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">执行规划</h2>
        <Button size="sm" variant="outline" onClick={handleCreate}>
          <Plus className="mr-1 size-4" />
          新建规划
        </Button>
      </div>

      {!activePlan ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
          点击「新建规划」开始列出子任务
        </div>
      ) : (
        <PlanDetail
          plan={activePlan}
          agents={agents}
          onAddItem={handleAddItem}
          onRemoveItem={handleRemoveItem}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

function PlanDetail({
  plan,
  agents,
  onAddItem,
  onRemoveItem,
  onSubmit,
}: {
  plan: PlanWithItems;
  agents: { name: string }[];
  onAddItem: () => void;
  onRemoveItem: (itemId: string) => void;
  onSubmit: () => void;
}) {
  const items = plan.items ?? [];
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto">
      <div className="text-muted-foreground text-xs">
        {plan.title} · {items.length} 个任务
      </div>

      {items.map((item) => (
        <ItemRow
          key={item.itemId}
          item={item}
          planStableId={plan.planId}
          agents={agents}
          onRemove={() => onRemoveItem(item.itemId)}
        />
      ))}

      <Button size="sm" variant="ghost" onClick={onAddItem}>
        <Plus className="mr-1 size-4" />
        添加任务
      </Button>

      <div className="mt-auto flex justify-end">
        <Button size="sm" onClick={onSubmit} disabled={items.length === 0}>
          <Send className="mr-1 size-4" />
          生成执行指令
        </Button>
      </div>
    </div>
  );
}

function ItemRow({
  item,
  planStableId,
  agents,
  onRemove,
}: {
  item: AgentOrchestrationPlanItem;
  planStableId: string;
  agents: { name: string }[];
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Agent</Label>
          <select
            className="mt-1 w-full rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
            defaultValue={item.agentName}
            onChange={(e) => {
              void updatePlanItemAction(
                item.itemId,
                { agentName: e.target.value },
                planStableId,
              );
            }}
          >
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs">依赖 (itemId 逗号分隔)</Label>
          <Input
            className="mt-1"
            defaultValue={item.dependsOn.join(',')}
            placeholder="(可空)"
            onChange={(e) => {
              const deps = e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              void updatePlanItemAction(
                item.itemId,
                { dependsOn: deps },
                planStableId,
              );
            }}
          />
        </div>
      </div>
      <Label className="text-xs">任务描述</Label>
      <textarea
        className="mt-1 w-full rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        rows={2}
        defaultValue={item.task}
        onChange={(e) => {
          void updatePlanItemAction(
            item.itemId,
            { task: e.target.value },
            planStableId,
          );
        }}
      />
      <div className="mt-2 flex justify-between text-muted-foreground text-xs">
        <span>{item.itemId}</span>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
