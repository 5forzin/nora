/**
 * @vitest-environment jsdom
 *
 * The invite table's "accepted by" column.
 *
 * `acceptedUserId` was already on the wire and already in the type, and the table fetched it and
 * threw it away — on the one screen whose four other operations ask the operator for exactly that
 * id. An accepted invite is the only place in the product that pairs a person's e-mail with their
 * user id, so dropping it meant the id existed nowhere a human could read it.
 *
 * Cells are addressed by `data-testid` and by column index, never by caption: the captions are
 * pt-BR product copy.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listInvites = vi.fn();
const listGroups = vi.fn();
const inviteUser = vi.fn();
vi.mock('@/lib/api/client', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  listInvites: (...a: unknown[]) => listInvites(...a),
  listGroups: (...a: unknown[]) => listGroups(...a),
  inviteUser: (...a: unknown[]) => inviteUser(...a),
}));

import InvitationCard from '@/components/invitation-card';

const PENDING = {
  id: 'i-1',
  tenantId: 't-1',
  email: 'pendente@example.com',
  status: 'PENDING' as const,
  invitedBy: 'root-1',
  invitedAt: '2026-08-01T10:00:00Z',
  expiresAt: '2026-08-08T10:00:00Z',
  groupIds: [],
  acceptedAt: null,
  acceptedUserId: null,
};

const ACCEPTED = {
  ...PENDING,
  id: 'i-2',
  email: 'ana@example.com',
  status: 'ACCEPTED' as const,
  acceptedAt: '2026-08-02T09:00:00Z',
  acceptedUserId: 'u-42',
};

beforeEach(() => {
  listGroups.mockReset().mockResolvedValue([]);
  inviteUser.mockReset().mockResolvedValue({});
  listInvites
    .mockReset()
    .mockResolvedValue({ items: [PENDING, ACCEPTED], total: 2, page: 0, size: 20 });
});

afterEach(cleanup);

describe('invitation table — accepted by', () => {
  it('shows the user id of whoever accepted the invite', async () => {
    render(<InvitationCard />);

    const cell = await vi.waitFor(() => screen.getByTestId(`invite-accepted-by-${ACCEPTED.id}`));
    expect(cell.textContent).toBe('u-42');
  });

  it('carries the acceptance date in the title, where it does not crowd the table', async () => {
    render(<InvitationCard />);

    const cell = await vi.waitFor(() => screen.getByTestId(`invite-accepted-by-${ACCEPTED.id}`));
    expect(cell.getAttribute('title')).toContain('u-42');
  });

  it('leaves the cell empty for an invite nobody has accepted', async () => {
    render(<InvitationCard />);

    await vi.waitFor(() => screen.getByTestId(`invite-accepted-by-${ACCEPTED.id}`));
    expect(screen.queryByTestId(`invite-accepted-by-${PENDING.id}`)).toBeNull();
  });

  it('gives the column a header, so the ids are not an unexplained extra field', async () => {
    render(<InvitationCard />);

    await vi.waitFor(() => screen.getByTestId(`invite-accepted-by-${ACCEPTED.id}`));
    const headers = [...document.querySelectorAll('thead th')];
    const rowCells = [
      ...(
        screen.getByTestId(`invite-accepted-by-${ACCEPTED.id}`).closest('tr') as HTMLTableRowElement
      ).cells,
    ];
    // One header per cell: the column was added to both halves of the table, not just the body.
    expect(headers.length).toBe(rowCells.length);
  });
});

describe('Enterprise invitations', () => {
  it('reloads prepared groups while preserving the invitation draft and requiring a selection', async () => {
    const { rerender } = render(<InvitationCard requireGroup />);
    fireEvent.click(screen.getByRole('button', { name: 'Convidar usuário' }));
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'new@example.invalid' } });
    listGroups.mockResolvedValue([{ id: 'readers', name: 'Somente leitura' }]);
    rerender(<InvitationCard requireGroup groupsRevision={1} />);
    const group = await screen.findByRole('checkbox', { name: 'Somente leitura' });
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('new@example.invalid');
    expect((group as HTMLInputElement).checked).toBe(false);
    expect(inviteUser).not.toHaveBeenCalled();
  });
  it('requires an access group and passes the explicit selection to the invitation API', async () => {
    listGroups.mockResolvedValue([{ id: 'viewers', name: 'Visualizadores' }]);
    render(<InvitationCard requireGroup />);
    fireEvent.click(screen.getByRole('button', { name: 'Convidar usuário' }));
    await screen.findByText('Visualizadores');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'new@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await screen.findByText('Selecione ao menos um grupo para definir o acesso do usuário.');
    expect(inviteUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visualizadores' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await vi.waitFor(() =>
      expect(inviteUser).toHaveBeenCalledWith({
        email: 'new@example.invalid',
        groupIds: ['viewers'],
        expiresInDays: 7,
      }),
    );
  });
});
