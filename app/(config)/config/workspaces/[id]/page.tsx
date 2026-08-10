import { WorkspaceDetail } from '@/components/config/sections/workspace-detail';

/**
 * Workspace detail route (/config/workspaces/[id]). Auth + layout come
 * from app/(config)/config/layout.tsx; ownership is enforced server-side
 * by GET /api/workspaces/[id] (403 for non-owners, 404 for unknown ids).
 */
export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkspaceDetail id={id} />;
}
