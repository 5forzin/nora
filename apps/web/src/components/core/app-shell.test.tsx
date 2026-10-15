/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readerWorkspace } from '@/fixtures/workspace-access';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/enterprise/workspace-provider', () => ({ useWorkspaceAccess: () => ({ access: readerWorkspace, loading: false }) }));
vi.mock('@/lib/auth', () => ({ SESSION_USER_EVENT: 'test-session', getCurrentUser: () => ({ displayName: 'Reader', email: 'reader@example.invalid' }), resumeSessionRefresh: vi.fn(), clearSession: vi.fn() }));
vi.mock('./app-sidebar-sessions', () => ({ AppSidebarSessions: () => null }));
vi.mock('./desktop-update-button', () => ({ DesktopUpdateButton: () => null }));
vi.mock('./command-palette', () => ({ CommandPalette: () => null }));

import { AppShell } from './app-shell';

afterEach(cleanup);

it('keeps account settings reachable without connectors or usage in either navigation surface', () => {
  render(<AppShell><h1>Meetings</h1></AppShell>);
  for (const name of ['Integrações', 'Credenciais MCP', 'Consumo']) {
    expect(screen.queryByRole('link', { name })).toBeNull();
  }
  expect(screen.getAllByRole('link', { name: 'Configurações' }).every((link) => link.getAttribute('href') === '/settings')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir menu' }));
  const drawer = screen.getByRole('navigation', { name: 'Navegação' });
  expect(drawer.className).toContain('is-open');
  expect(drawer.querySelector('a[href="/settings"]')).not.toBeNull();
  expect(drawer.querySelector('a[href="/usage"], a[href="/integrations"], a[href="/settings/mcp"]')).toBeNull();
});
