import { beforeEach, describe, expect, it, vi } from 'vitest';
const getMe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ getMe }));
import { workspaceDestination } from './navigation';

beforeEach(() => {
  getMe.mockReset();
});

describe('workspace destination', () => {
  it('opens Enterprise only for an entitled workspace with overview permission', async () => {
    getMe.mockResolvedValue({ plan: 'ENTERPRISE', capabilities: { viewExecutiveOverview: true } });
    expect(await workspaceDestination()).toBe('/enterprise');
    getMe.mockResolvedValue({
      plan: 'FREE',
      capabilities: { viewExecutiveOverview: true },
      permissions: { readMeetings: true },
    });
    expect(await workspaceDestination()).toBe('/dashboard');
    getMe.mockResolvedValue({
      plan: 'ENTERPRISE',
      capabilities: { viewExecutiveOverview: false },
      permissions: { readMeetings: true },
    });
    expect(await workspaceDestination()).toBe('/dashboard');
  });
  it.each([
    ['manageUsers', '/enterprise/users'],
    ['manageAccess', '/enterprise/access'],
    ['readCompanyContext', '/enterprise/company'],
  ])(
    'opens the authorized Enterprise entry for %s without meeting access',
    async (capability, route) => {
      getMe.mockResolvedValue({
        plan: 'ENTERPRISE',
        capabilities: { [capability]: true },
        permissions: {},
      });
      expect(await workspaceDestination()).toBe(route);
      expect(await workspaceDestination('/enterprise' as never)).toBe(route);
    },
  );
  it('uses personal settings when no product read permission is available', async () => {
    getMe.mockResolvedValue({ plan: 'ENTERPRISE', capabilities: {}, permissions: {} });
    expect(await workspaceDestination()).toBe('/settings/context');
  });
  it('preserves a requested meeting or chat without loading the profile', async () => {
    expect(await workspaceDestination('/chat' as never)).toBe('/chat');
    expect(getMe).not.toHaveBeenCalled();
  });
  it('does not infer an entitlement after a failed profile request', async () => {
    getMe.mockRejectedValue(new Error('offline'));
    expect(await workspaceDestination()).toBe('/dashboard');
  });
});
