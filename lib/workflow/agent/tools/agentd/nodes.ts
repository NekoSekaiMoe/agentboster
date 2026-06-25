import { selectBestNode } from '@/lib/workflow/agent/dispatch';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

/**
 * Online-node count probe for factory-time gating.
 *
 * Why a `'use step'` function: this code path is reached from inside the
 * Workflow DevKit vm sandbox (`@workflow/core/dist/vm/index.js`
 * `createContext()`), which deliberately injects only "stateless +
 * synchronous Web APIs" — there is NO `fetch`. The neon-http driver used
 * by `db` (`@neondatabase/serverless`) ends up calling the bare `fetch`
 * identifier (`(fetchFunction ?? fetch)(...)` in its query path), which
 * throws `ReferenceError: fetch is not defined`. Drizzle wraps that as
 * `Error: Failed query: <sql>` with no underlying Postgres message,
 * aborting the whole workflow run.
 *
 * The Workflow DevKit marshals `'use step'` functions back to the host
 * Node.js process to execute, where `fetch` is available. Other tools
 * in this tree already rely on this contract — see
 * `lib/workflow/agent/tools/tasks/summary.ts` `readTaskSummaryStep`.
 */
async function listOnlineNodesStep(
  requiredSandbox?: 'docker' | 'docker-strict' | 'lxc',
) {
  'use step';

  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  const rows = await db
    .select()
    .from(agentdNodes)
    .where(
      and(
        eq(agentdNodes.status, 'online'),
        gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
      ),
    );

  if (requiredSandbox) {
    return rows.filter((n) => {
      const sbs = n.sandboxes as string[] | null;
      return sbs ? sbs.includes(requiredSandbox) : false;
    });
  }
  return rows;
}

async function hasMultipleOnlineNodesStep() {
  'use step';

  const rows = await listOnlineNodesStep();
  return rows.length >= 2;
}

export default defineBuildInTool({
  id: 'agentd-nodes',
  description: `Query available agentd nodes and their resource status. Use this to inspect node capacity before delegating compute-intensive tasks.`,
  factory: async (_config, { appConfig }) => {
    const agentdEnabled = appConfig.agentd?.enabled ?? false;
    if (!agentdEnabled) {
      return null;
    }

    // Gated by an online-node count probe. `hasMultipleOnlineNodesStep`
    // is a `'use step'` function, so it runs on the host where `fetch`
    // exists — not inside the vm sandbox. See its docstring for why
    // this matters.
    const hasMulti = await hasMultipleOnlineNodesStep().catch(() => false);
    if (!hasMulti) {
      return null;
    }

    return {
      listNodes: tool({
        title: 'List AgentD Nodes',
        description: `List all online agentd nodes with CPU model, resource usage (CPU/memory/disk), and active task count. Use this to choose which node should handle a specific task based on available resources.`,
        inputSchema: z.object({
          requiredSandbox: z
            .enum(['docker', 'docker-strict', 'lxc'])
            .optional()
            .describe(
              'Filter nodes by required sandbox type (docker/docker-strict/lxc)',
            ),
        }),
        execute: async (input) => {
          const rows = await listOnlineNodesStep(input.requiredSandbox);

          const nodes = rows.map((n) => ({
            nodeId: n.nodeID,
            ip: n.ip,
            port: n.port,
            cpuModel: n.cpuModel || 'Unknown',
            cpuUsage: n.cpuUsage != null ? `${n.cpuUsage}%` : 'N/A',
            memoryUsage: n.memAvail != null ? `${100 - n.memAvail}%` : 'N/A',
            diskUsage: n.diskAvail != null ? `${100 - n.diskAvail}%` : 'N/A',
            activeTasks: n.activeTasks || 0,
            activeSandboxes: n.activeSandboxes || 0,
            sandboxes: (n.sandboxes as string[]) || [],
          }));

          return {
            totalNodes: nodes.length,
            nodes,
          };
        },
      }),

      getBestNode: tool({
        title: 'Get Best AgentD Node',
        description: `Get the recommended agentd node based on current resource availability. The selection algorithm considers CPU usage (40%), memory availability (40%), and disk space (20%). Returns null if no suitable node is available.`,
        inputSchema: z.object({
          requiredSandbox: z
            .enum(['docker', 'docker-strict', 'lxc'])
            .optional()
            .describe('Required sandbox type'),
        }),
        execute: async (input) => {
          // `selectBestNode` lives in dispatch.ts and calls `db` directly.
          // It is safe to call from inside a `'use step'` execute body
          // because tool execute callbacks are themselves run on the host
          // (the DevKit marshals the tool-execution channel back to the
          // Node.js process). If selectBestNode is ever invoked from
          // factory-time code instead, it must be lifted into a step.
          const node = await selectBestNode(input.requiredSandbox);
          if (!node) {
            return {
              available: false,
              reason: 'No online nodes or all nodes overloaded',
            };
          }

          return {
            available: true,
            nodeId: node.nodeID,
            ip: node.ip,
            port: node.port,
            cpuUsage: node.cpuUsage != null ? `${node.cpuUsage}%` : 'N/A',
            memoryAvailable:
              node.memAvail != null ? `${node.memAvail}%` : 'N/A',
            diskAvailable:
              node.diskAvail != null ? `${node.diskAvail}%` : 'N/A',
            activeTasks: node.activeTasks,
          };
        },
      }),
    };
  },
});
