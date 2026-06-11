import { selectBestNode } from '@/lib/workflow/agent/dispatch';
import { db } from '@/lib/core/db';
import { agentdNodes } from '@/lib/core/db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

export default defineBuildInTool({
  id: 'agentd-nodes',
  description: `Query available agentd nodes and their resource status. Use this to inspect node capacity before delegating compute-intensive tasks.`,
  factory: async (_config, { appConfig }) => {
    const agentdEnabled = appConfig.agentd?.enabled ?? false;
    if (!agentdEnabled) {
      return null;
    }

    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const onlineNodes = await db
      .select()
      .from(agentdNodes)
      .where(
        and(
          eq(agentdNodes.status, 'online'),
          gte(agentdNodes.lastHeartbeat, twoMinutesAgo),
        ),
      );

    if (onlineNodes.length < 2) {
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

          let filtered = rows;
          if (input.requiredSandbox) {
            filtered = rows.filter((n) => {
              const sbs = n.sandboxes as string[] | null;
              return sbs ? sbs.includes(input.requiredSandbox!) : false;
            });
          }

          const nodes = filtered.map((n) => ({
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
