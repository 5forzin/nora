/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const getMe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ getMe }));
import { WorkspaceProvider, useWorkspaceAccess } from './workspace-provider';

function AccessProbe() {
  const { access, loading } = useWorkspaceAccess();
  return <div>{loading ? 'Loading' : (access?.plan ?? 'Unavailable')}</div>;
}
beforeEach(() => {
  getMe.mockReset();
});
afterEach(cleanup);

describe('workspace capabilities', () => {
  it('uses authenticated API data instead of a plan in the display cookie', async () => {
    document.cookie = `nora_user=${encodeURIComponent(JSON.stringify({ plan: 'ENTERPRISE', root: true }))}`;
    getMe.mockResolvedValue({ plan: 'FREE' });
    render(
      <WorkspaceProvider>
        <AccessProbe />
      </WorkspaceProvider>,
    );
    await screen.findByText('FREE');
    expect(screen.queryByText('ENTERPRISE')).toBeNull();
  });
  it('fails closed when the authenticated profile cannot load', async () => {
    getMe.mockRejectedValue(new Error('offline'));
    render(
      <WorkspaceProvider>
        <AccessProbe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
  });
});
