import { redirect } from 'next/navigation';
import type { WorkspacePermissions } from '@/lib/api/types';
import { getWorkspaceAccess } from './access';
import { workspaceHome } from './navigation';

export async function requireWorkspacePermission(permission: keyof WorkspacePermissions) {
  const access = await getWorkspaceAccess();
  if (!access.permissions?.[permission]) redirect(workspaceHome(access));
  return access;
}
