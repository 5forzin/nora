/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpTokenSummary } from '@/lib/api/client';

const api = vi.hoisted(() => ({
  listMcpTokens: vi.fn(), createMcpToken: vi.fn(), revokeMcpToken: vi.fn(),
}));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  ...api,
}));

import McpSettingsPage from './page';

const TOKEN: McpTokenSummary = {
  id: 'test-token-id', name: 'Test client', createdAt: '2026-10-14T12:00:00Z',
  expiresAt: null, revokedAt: null, lastUsedAt: null, active: true,
};
const REVEAL = { ...TOKEN, token: 'synthetic-test-credential-not-valid' };
const writeText = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  api.listMcpTokens.mockResolvedValue([]);
  api.createMcpToken.mockResolvedValue(REVEAL);
  api.revokeMcpToken.mockResolvedValue(undefined);
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(cleanup);

function createCredential() {
  fireEvent.change(screen.getByLabelText('Nome da credencial'), { target: { value: '  Test client  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
}

describe('MCP credentials', () => {
  it('creates, reveals, copies and dismisses a credential without exposing it in the list', async () => {
    api.listMcpTokens.mockResolvedValueOnce([]).mockResolvedValue([TOKEN]);
    render(<McpSettingsPage />);
    await screen.findByText('Nenhuma credencial criada ainda.');
    createCredential();
    await screen.findByText(REVEAL.token);
    expect(api.createMcpToken).toHaveBeenCalledWith({ name: 'Test client' });
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    await screen.findByRole('button', { name: 'Copiado' });
    expect(writeText).toHaveBeenCalledWith(REVEAL.token);
    fireEvent.click(screen.getByRole('button', { name: 'Já guardei' }));
    expect(screen.queryByText(REVEAL.token)).toBeNull();
    expect(screen.getByText(TOKEN.name)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copiar' })).toBeNull();
  });

  it('rejects an empty credential name without calling the API', async () => {
    render(<McpSettingsPage />);
    await screen.findByText('Nenhuma credencial criada ainda.');
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
    expect(screen.getByText('Dê um nome para reconhecer esta credencial depois.')).toBeTruthy();
    expect(api.createMcpToken).not.toHaveBeenCalled();
  });

  it('lets a failed creation be retried and clears the error', async () => {
    api.createMcpToken.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(REVEAL);
    render(<McpSettingsPage />);
    await screen.findByText('Nenhuma credencial criada ainda.');
    createCredential();
    await screen.findByText('Não foi possível criar a credencial.');
    fireEvent.click(screen.getByRole('button', { name: 'Criar credencial' }));
    await screen.findByText(REVEAL.token);
    expect(screen.queryByText('Não foi possível criar a credencial.')).toBeNull();
  });

  it('retries a failed initial list request and removes its error', async () => {
    api.listMcpTokens.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([TOKEN]);
    render(<McpSettingsPage />);
    await screen.findByText('Não foi possível carregar as credenciais.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText(TOKEN.name);
    expect(screen.queryByText('Não foi possível carregar as credenciais.')).toBeNull();
  });

  it('retries a failed revocation without retaining the old error', async () => {
    api.listMcpTokens.mockResolvedValueOnce([TOKEN]).mockResolvedValue([{ ...TOKEN, active: false }]);
    api.revokeMcpToken.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    render(<McpSettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
    await screen.findByText('Não foi possível revogar a credencial.');
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await screen.findByText('Revogada');
    expect(api.revokeMcpToken).toHaveBeenNthCalledWith(2, TOKEN.id);
    expect(screen.queryByText('Não foi possível revogar a credencial.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revogar' })).toBeNull();
  });

  it('removes a revealed credential after its revocation succeeds', async () => {
    api.listMcpTokens.mockResolvedValueOnce([]).mockResolvedValueOnce([TOKEN])
      .mockResolvedValue([{ ...TOKEN, active: false }]);
    render(<McpSettingsPage />);
    await screen.findByText('Nenhuma credencial criada ainda.');
    createCredential();
    await screen.findByText(REVEAL.token);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
    await screen.findByText('Revogada');
    expect(screen.queryByText(REVEAL.token)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copiar' })).toBeNull();
  });

  it('keeps a confirmed revocation visible when the following list refresh fails', async () => {
    api.listMcpTokens.mockResolvedValueOnce([TOKEN]).mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue([{ ...TOKEN, active: false }]);
    render(<McpSettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
    await screen.findByText('Não foi possível carregar as credenciais.');
    expect(screen.getByText('Revogada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revogar' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(screen.queryByText('Não foi possível carregar as credenciais.')).toBeNull());
  });

  it('explains clipboard failure and allows copying again', async () => {
    writeText.mockRejectedValueOnce(new Error('Denied')).mockResolvedValue(undefined);
    render(<McpSettingsPage />);
    await screen.findByText('Nenhuma credencial criada ainda.');
    createCredential();
    await screen.findByText(REVEAL.token);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    await screen.findByText('Não foi possível copiar. Selecione e copie o valor acima.');
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    await screen.findByRole('button', { name: 'Copiado' });
    expect(screen.queryByText('Não foi possível copiar. Selecione e copie o valor acima.')).toBeNull();
  });

  it('ignores an older list response after creating a credential', async () => {
    let finishInitial!: (tokens: McpTokenSummary[]) => void;
    api.listMcpTokens.mockReturnValueOnce(new Promise<McpTokenSummary[]>((resolve) => { finishInitial = resolve; }))
      .mockResolvedValue([TOKEN]);
    render(<McpSettingsPage />);
    createCredential();
    await screen.findByText(TOKEN.name);
    await act(async () => { finishInitial([]); });
    expect(screen.getByText(TOKEN.name)).toBeTruthy();
  });
});
