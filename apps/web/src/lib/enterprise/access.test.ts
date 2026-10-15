import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMe, redirect, notFound } = vi.hoisted(() => ({
  getMe: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  notFound: vi.fn(() => { throw new Error('not-found'); }),
}));

vi.mock('@/lib/api/client', () => ({ getMe }));
vi.mock('next/navigation', () => ({ redirect, notFound }));

import { requireEnterpriseAccess } from './access';

describe('Enterprise page access', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['FREE', 'PRO', undefined])('keeps %s workspaces outside Enterprise pages', async (plan) => {
    getMe.mockResolvedValue({ plan, capabilities: { manageUsers: true } });
    await expect(requireEnterpriseAccess('manageUsers')).rejects.toThrow('redirect:/dashboard');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('authorizes the current server response, including changes within the same session', async () => {
    const enterprise = { plan: 'ENTERPRISE', capabilities: { manageUsers: true } };
    getMe.mockResolvedValueOnce(enterprise).mockResolvedValueOnce({ plan: 'FREE' });
    await expect(requireEnterpriseAccess('manageUsers')).resolves.toBe(enterprise);
    await expect(requireEnterpriseAccess('manageUsers')).rejects.toThrow('redirect:/dashboard');
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it.each([false, undefined])('denies a missing or false member capability (%s)', async (allowed) => {
    getMe.mockResolvedValue({ plan: 'ENTERPRISE', capabilities: { manageUsers: allowed } });
    await expect(requireEnterpriseAccess('manageUsers')).rejects.toThrow('not-found');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('does not turn API failures into permission grants', async () => {
    getMe.mockRejectedValue(new Error('API unavailable'));
    await expect(requireEnterpriseAccess()).rejects.toThrow('API unavailable');
    expect(redirect).not.toHaveBeenCalled();
  });
});
