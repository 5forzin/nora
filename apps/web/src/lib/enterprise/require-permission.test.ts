import { beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ read: vi.fn(), redirect: vi.fn() }));
vi.mock('./access', () => ({ getWorkspaceAccess: session.read }));
vi.mock('next/navigation', () => ({ redirect: session.redirect }));
import { requireWorkspacePermission } from './require-permission';

beforeEach(() => {
  session.read.mockReset();
  session.redirect.mockReset().mockImplementation(() => {
    throw new Error('redirect');
  });
});

it('returns the authenticated profile when the requested permission is granted', async () => {
  const profile = { plan: 'FREE', permissions: { readMeetings: true } };
  session.read.mockResolvedValue(profile);
  expect(await requireWorkspacePermission('readMeetings')).toBe(profile);
  expect(session.redirect).not.toHaveBeenCalled();
});

it('redirects a denied reader to an authorized administration page', async () => {
  session.read.mockResolvedValue({
    plan: 'ENTERPRISE',
    capabilities: { manageUsers: true },
    permissions: { readMeetings: false },
  });
  await expect(requireWorkspacePermission('readMeetings')).rejects.toThrow('redirect');
  expect(session.redirect).toHaveBeenCalledWith('/enterprise/users');
});

it('fails closed when permission metadata is absent', async () => {
  session.read.mockResolvedValue({ plan: 'ENTERPRISE', capabilities: {} });
  await expect(requireWorkspacePermission('readMeetings')).rejects.toThrow('redirect');
  expect(session.redirect).toHaveBeenCalledWith('/settings/context');
});
