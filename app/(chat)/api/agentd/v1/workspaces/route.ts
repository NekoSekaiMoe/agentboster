import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  getWorkspaceByProjectId,
  listWorkspaces,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.workspaces');

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id');
  const agentId = searchParams.get('agent_id');
  const id = searchParams.get('id');

  if (id) {
    const ws = await getWorkspace(id);
    if (!ws) {
      return Response.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: ws });
  }

  if (projectId) {
    const ws = await getWorkspaceByProjectId(projectId);
    if (!ws) {
      return Response.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: ws });
  }

  if (agentId) {
    const wsList = await listWorkspaces(agentId);
    return Response.json({ success: true, data: wsList });
  }

  return Response.json(
    { success: false, error: 'Missing id, project_id, or agent_id' },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { project_id, agent_id, name, sandbox_id, sandbox_type } = body;

    if (!project_id || !agent_id || !sandbox_id) {
      return Response.json(
        {
          success: false,
          error: 'Missing project_id, agent_id, or sandbox_id',
        },
        { status: 400 },
      );
    }

    const ws = await createWorkspace({
      projectId: project_id,
      agentId: agent_id,
      name,
      sandboxId: sandbox_id,
      sandboxType: sandbox_type ?? 'docker',
    });

    logger.info('workspace created', {
      workspaceId: ws.id,
      projectId: ws.projectId,
    });
    return Response.json({ success: true, data: ws }, { status: 201 });
  } catch (error) {
    logger.error('workspace creation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to create workspace' },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return Response.json(
      { success: false, error: 'Missing workspace id' },
      { status: 400 },
    );
  }

  const body = await request.json();
  if (body.action === 'archive') {
    const ws = await archiveWorkspace(id);
    if (!ws) {
      return Response.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: ws });
  }

  return Response.json(
    { success: false, error: 'Unknown action' },
    { status: 400 },
  );
}
