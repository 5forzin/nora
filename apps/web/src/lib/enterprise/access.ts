import { notFound, redirect } from 'next/navigation';

import { getMe } from '@/lib/api/client';
import type { MeResponse, WorkspaceCapabilities } from '@/lib/api/types';

export async function getWorkspaceAccess(): Promise<MeResponse> {
  return getMe();
}

export async function requireEnterpriseAccess(
  capability?: keyof WorkspaceCapabilities,
): Promise<MeResponse> {
  const workspace = await getWorkspaceAccess();
  if (workspace.plan !== 'ENTERPRISE') redirect('/dashboard');
  if (capability && workspace.capabilities?.[capability] !== true) notFound();
  return workspace;
}
