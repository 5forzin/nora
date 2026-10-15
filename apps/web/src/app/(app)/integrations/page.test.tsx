/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IntegrationStatus } from '@/lib/api/types';

const listIntegrations = vi.fn();
const disconnectIntegration = vi.fn();
const permissions = vi.hoisted(() => ({ readIntegrations: true, manageIntegrations: true }));
vi.mock('@/components/enterprise/workspace-provider', () => ({
  useWorkspaceAccess: () => ({ access: { permissions }, loading: false }),
}));
const router = { replace: vi.fn() };
const searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => searchParams }));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  listIntegrations: (...args: unknown[]) => listIntegrations(...args),
  disconnectIntegration: (...args: unknown[]) => disconnectIntegration(...args),
}));

import IntegrationsPage from './page';

const status = (provider: IntegrationStatus['provider'], configured: boolean, connected: boolean): IntegrationStatus =>
  ({ provider, configured, connected, externalAccount: null, connectedAt: null });

beforeEach(() => { permissions.readIntegrations = true; permissions.manageIntegrations = true; listIntegrations.mockReset(); disconnectIntegration.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

it('shows connection status without connection controls for a reader', async () => {
  permissions.manageIntegrations = false;
  listIntegrations.mockResolvedValue([status('google', true, true), status('slack', true, false)]);
  render(<IntegrationsPage />);
  await screen.findByRole('region', { name: /Google/ });
  expect(screen.getByText('Conectado')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Desconectar' })).toBeNull();
});

it('does not load integrations without read access', () => {
  permissions.readIntegrations = false;
  render(<IntegrationsPage />);
  expect(screen.getByText('Você não tem permissão para consultar integrações neste workspace.')).toBeTruthy();
  expect(listIntegrations).not.toHaveBeenCalled();
});

it('hides unavailable connectors and the roadmap while keeping configured connection controls', async () => {
  listIntegrations.mockResolvedValue([status('google', true, false), status('slack', false, false)]);
  render(<IntegrationsPage />);
  const google = await screen.findByRole('region', { name: /Google/ });
  expect(within(google).getByRole('button', { name: 'Conectar' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Slack' })).toBeNull();
  expect(screen.queryByText(/Jira/)).toBeNull();
});

it('shows a useful empty state without offering unavailable connection actions', async () => {
  listIntegrations.mockResolvedValue([status('google', false, false)]);
  render(<IntegrationsPage />);
  expect(await screen.findByText('Nenhuma integração disponível neste ambiente.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Conectar' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Voltar aos fluxos' }).getAttribute('href')).toBe('/flows');
});

it('preserves a connection whose server config was removed and lets the user disconnect it', async () => {
  listIntegrations.mockResolvedValue([status('google', false, true)]);
  render(<IntegrationsPage />);
  const google = await screen.findByRole('region', { name: /Google/ });
  expect(within(google).getByText('Conexão indisponível')).toBeTruthy();
  fireEvent.click(within(google).getByRole('button', { name: 'Desconectar' }));
  fireEvent.click(within(google).getByRole('button', { name: 'Sim, desconectar' }));
  await waitFor(() => expect(disconnectIntegration).toHaveBeenCalledWith('google'));
  await waitFor(() => expect(screen.queryByRole('region', { name: /Google/ })).toBeNull());
});
