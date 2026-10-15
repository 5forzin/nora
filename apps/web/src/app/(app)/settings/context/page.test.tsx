/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  me: vi.fn(), updateMe: vi.fn(), password: vi.fn(), tenant: vi.fn(), rename: vi.fn(),
  context: vi.fn(), versions: vi.fn(), version: vi.fn(), saveContext: vi.fn(),
  updateSession: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ readWorkspace: true, renameWorkspace: true, readMeetings: true }));
vi.mock('@/components/enterprise/workspace-provider', () => ({
  useWorkspaceAccess: () => ({ access: { permissions }, loading: false }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/api/client', async (original) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await original<typeof import('@/lib/api/client')>()),
  getMe: api.me, updateMe: api.updateMe, changePassword: api.password,
  getTenant: api.tenant, renameTenant: api.rename, getTenantContext: api.context,
  listTenantContextVersions: api.versions, getTenantContextVersion: api.version,
  upsertTenantContext: api.saveContext,
}));
vi.mock('@/lib/auth', () => ({
  getCurrentUser: () => ({ displayName: 'Freelancer', email: 'freelancer@example.invalid' }),
  updateSessionUser: api.updateSession,
  clearLocalSession: vi.fn(),
}));

import SettingsPage from './page';
import CompanyContextForm from '@/components/enterprise/company-context-form';
import { ApiRequestError } from '@/lib/api/client';

const profile = { displayName: 'Freelancer', email: 'freelancer@example.invalid', emailVerified: true };
const tenant = { name: 'Independent Studio', slug: 'independent-studio', plan: 'FREE' };
const context = { companyName: 'Current company', products: [], competitors: [], objectionHandling: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  permissions.readWorkspace = true;
  permissions.renameWorkspace = true;
  permissions.readMeetings = true;
  vi.clearAllMocks();
  history.replaceState(null, '', '/');
  api.me.mockReset().mockResolvedValue(profile);
  api.updateMe.mockReset().mockResolvedValue({ ...profile, displayName: 'Updated freelancer' });
  api.password.mockReset().mockResolvedValue(undefined);
  api.tenant.mockReset().mockResolvedValue(tenant);
  api.rename.mockReset().mockResolvedValue({ ...tenant, name: 'New studio' });
  api.context.mockReset().mockResolvedValue(context);
  api.saveContext.mockReset().mockImplementation(async (value) => value);
  api.versions.mockReset().mockResolvedValue({ currentVersion: 2, items: [2, 1].map((version) => ({ version, createdAt: '2026-10-14T10:00:00Z' })) });
  api.version.mockReset();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Core account settings', () => {
  it('links usage from account settings only when the user may read the report', async () => {
    const view = render(<SettingsPage />);
    await screen.findByText('Verificado');
    expect(screen.getByRole('link', { name: 'Consumo' }).getAttribute('href')).toBe('/settings/usage');
    permissions.readMeetings = false;
    view.rerender(<SettingsPage />);
    expect(screen.queryByRole('link', { name: 'Consumo' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Conta' })).toBeTruthy();
  });
  it('keeps workspace details read-only without rename permission', async () => {
    permissions.renameWorkspace = false;
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Workspace' }));
    await waitFor(() => expect((screen.getByLabelText('Nome do workspace') as HTMLInputElement).value).toBe(tenant.name));
    expect((screen.getByLabelText('Nome do workspace') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Salvar alterações' })).toBeNull();
  });
  it('keeps personal settings available without querying forbidden workspace details', async () => {
    permissions.readWorkspace = false;
    history.replaceState(null, '', '/#workspace');
    render(<SettingsPage />);
    await screen.findByText('Verificado');
    expect(screen.queryByRole('link', { name: 'Workspace' })).toBeNull();
    expect(api.tenant).not.toHaveBeenCalled();
  });
  it('saves a display name and refreshes the session display used by the sidebar', async () => {
    render(<SettingsPage />);
    await screen.findByText('Verificado');
    fireEvent.change(screen.getByLabelText('Nome de exibição'), { target: { value: '  Updated freelancer  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await screen.findByText('Salvo');
    expect(api.updateMe).toHaveBeenCalledWith({ displayName: 'Updated freelancer' });
    expect(api.updateSession).toHaveBeenCalledWith({ displayName: 'Updated freelancer' });
  });

  it('reports the wrong current password and allows a corrected retry', async () => {
    api.password.mockRejectedValueOnce(new ApiRequestError(401, 'Invalid credentials'));
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Segurança' }));
    fireEvent.change(screen.getByLabelText('Senha atual'), { target: { value: 'WrongCurrent!9' } });
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'SyntheticNext!9' } });
    fireEvent.change(screen.getByLabelText('Confirme a nova senha'), { target: { value: 'SyntheticNext!9' } });
    const submit = screen.getByRole('button', { name: /Atualizar senha/ });
    fireEvent.click(submit);
    await screen.findByText('Senha atual incorreta.');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Senha atual'), { target: { value: 'CorrectCurrent!9' } });
    fireEvent.click(submit);
    await waitFor(() => expect((screen.getByLabelText('Senha atual') as HTMLInputElement).value).toBe(''));
    expect(api.password).toHaveBeenCalledTimes(2);
  });

  it('renames the workspace while preserving its immutable slug', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Workspace' }));
    const name = await screen.findByLabelText('Nome do workspace');
    fireEvent.change(name, { target: { value: 'New studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await screen.findByText('Salvo');
    expect(api.rename).toHaveBeenCalledWith({ name: 'New studio' });
    expect(screen.getByText('independent-studio')).toBeTruthy();
  });
});

describe('Enterprise context history', () => {
  it('keeps the selected version when an earlier request completes out of order', async () => {
    const first = deferred<{ document: typeof context }>();
    const second = deferred<{ document: typeof context }>();
    api.version.mockImplementation((version) => version === 1 ? first.promise : second.promise);
    render(<CompanyContextForm />);
    await screen.findByLabelText(/Nome da empresa/);
    const buttons = await screen.findAllByRole('button', { name: 'Ver' });
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[0]);
    await act(async () => second.resolve({ document: { ...context, companyName: 'Second version company' } }));
    await screen.findByText('Second version company');
    await act(async () => first.resolve({ document: { ...context, companyName: 'First version company' } }));
    expect(screen.queryByText('First version company')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar no formulário' }));
    expect((screen.getByLabelText(/Nome da empresa/) as HTMLInputElement).value).toBe('Second version company');
    expect(api.saveContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contexto' }));
    await screen.findByText('Contexto salvo com sucesso.');
    expect(api.saveContext).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Second version company' }));
  });
});


describe('Enterprise context permissions', () => {
  it('keeps company configuration out of personal settings', async () => {
    render(<SettingsPage />);
    await screen.findByText('Verificado');
    expect(screen.queryByRole('link', { name: 'Contexto da empresa' })).toBeNull();
    expect(api.context).not.toHaveBeenCalled();
  });
  it('renders the company context without editing or restoration for a reader', async () => {
    render(<CompanyContextForm canEdit={false} />);
    await screen.findByText('Current company');
    expect(screen.queryByRole('button', { name: 'Salvar contexto' })).toBeNull();
    expect(screen.queryByLabelText('Nome da empresa')).toBeNull();
    api.version.mockResolvedValue({ document: context });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ver' })[0]);
    await waitFor(() => expect(api.version).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Restaurar no formulário' })).toBeNull();
  });
});


describe('Enterprise context loading', () => {
  it('prevents a failed read from becoming an empty editable replacement and supports retry', async () => {
    api.context.mockRejectedValueOnce(new Error('offline'));
    render(<CompanyContextForm />);
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    expect(screen.queryByRole('button', { name: 'Salvar contexto' })).toBeNull();
    fireEvent.click(retry);
    await screen.findByDisplayValue('Current company');
    expect(api.saveContext).not.toHaveBeenCalled();
  });
});
