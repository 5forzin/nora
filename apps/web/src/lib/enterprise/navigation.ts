import type { Route } from 'next';
import { getMe, type MeResponse } from '@/lib/api/client';

export function workspaceHome(access: MeResponse): Route {
  if (access.plan === 'ENTERPRISE') {
    if (access.capabilities?.viewExecutiveOverview) return '/enterprise' as Route;
    if (access.capabilities?.manageUsers) return '/enterprise/users' as Route;
    if (access.capabilities?.manageAccess) return '/enterprise/access' as Route;
    if (access.capabilities?.readCompanyContext) return '/enterprise/company' as Route;
  }
  if (access.permissions?.readMeetings) return '/dashboard' as Route;
  if (access.permissions?.readTasks) return '/tasks' as Route;
  if (access.permissions?.readFlows) return '/flows' as Route;
  if (access.permissions?.readIntegrations) return '/integrations' as Route;
  return '/settings/context' as Route;
}

/** Resolve the workspace landing only after the authentication cookies are set. */
export async function workspaceDestination(
  requested: Route = '/dashboard' as Route,
): Promise<Route> {
  if (requested !== '/dashboard' && requested !== '/enterprise') return requested;
  try {
    const access = await getMe();
    return workspaceHome(access);
  } catch {
    // The ordinary workspace remains reachable when the profile request fails.
  }
  return requested;
}
