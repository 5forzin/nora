/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ users: vi.fn(), groups: vi.fn(), members: vi.fn() }));
const prepareAccess = vi.hoisted(() => vi.fn());
vi.mock('./standard-access', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('./standard-access')>()),
  prepareStandardAccess: prepareAccess,
}));
vi.mock('@/lib/api/client', () => ({
  listIamUsers: api.users,
  listGroups: api.groups,
  listGroupMembers: api.members,
}));
vi.mock('@/components/invitation-card', () => ({
  default: ({
    requireGroup,
    groupsRevision,
  }: {
    requireGroup: boolean;
    groupsRevision: number;
  }) => (
    <div
      data-testid="invite"
      data-require-group={requireGroup}
      data-groups-revision={groupsRevision}
    />
  ),
}));
import { EnterpriseUsers } from './enterprise-users';

beforeEach(() => {
  api.users.mockReset().mockResolvedValue([
    { id: 'root', displayName: 'Workspace owner', email: 'owner@example.invalid', root: true },
    { id: 'reader', displayName: 'Ana Souza', email: 'ana@example.invalid', root: false },
  ]);
  api.groups.mockReset().mockResolvedValue([{ id: 'viewers', name: 'Visualizadores' }]);
  api.members.mockReset().mockResolvedValue(['reader']);
  prepareAccess.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Enterprise users', () => {
  it('shows real memberships, keeps Root distinct and filters by name or email', async () => {
    render(<EnterpriseUsers canManageAccess />);
    await screen.findByText('Ana Souza');
    expect(screen.getByText('Visualizadores')).toBeTruthy();
    expect(screen.getByText('Acesso completo')).toBeTruthy();
    expect(screen.getByTestId('invite').getAttribute('data-require-group')).toBe('true');
    fireEvent.change(screen.getByLabelText('Buscar usuários'), { target: { value: 'ANA@' } });
    expect(screen.queryByText('Workspace owner')).toBeNull();
    expect(screen.getByText('Ana Souza')).toBeTruthy();
  });
  it('keeps the directory available when group reads fail without calling the member groupless', async () => {
    api.members.mockRejectedValue(new Error('forbidden'));
    render(<EnterpriseUsers canManageAccess={false} />);
    await screen.findByText('Ana Souza');
    expect(screen.getByText('Indisponível')).toBeTruthy();
    expect(screen.queryByText('Sem grupo')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Gerenciar grupos e permissões' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preparar acessos' })).toBeNull();
  });
  it('recovers a failed directory request', async () => {
    api.users.mockRejectedValueOnce(new Error('offline'));
    render(<EnterpriseUsers canManageAccess />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Ana Souza');
    expect(api.users).toHaveBeenCalledTimes(2);
  });
  it('prepares access only on request, retries a failure and refreshes invitation groups', async () => {
    prepareAccess.mockRejectedValueOnce(new Error('Connection lost'));
    render(<EnterpriseUsers canManageAccess />);
    await screen.findByText('Ana Souza');
    expect(prepareAccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preparar acessos' }));
    await screen.findByText('Preparação interrompida. Tente novamente para concluir os acessos.');
    fireEvent.click(screen.getByRole('button', { name: 'Preparar acessos' }));
    await screen.findByText('Acessos preparados. Escolha um grupo ao convidar.');
    expect(prepareAccess).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('invite').getAttribute('data-groups-revision')).toBe('1');
    expect(screen.queryByRole('button', { name: 'Preparar acessos' })).toBeNull();
  });
});
