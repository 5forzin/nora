/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: calls.refresh }) }));
vi.mock('@/lib/api/client', async (original) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await original<typeof import('@/lib/api/client')>()),
  setMeetingGoal: calls.save,
  deleteMeetingGoal: calls.remove,
}));

import MeetingProductivitySection from './meeting-productivity-section';
import { ApiRequestError } from '@/lib/api/client';

const goal = { purpose: 'Agree the project scope', expectedOutcomes: ['Approve the prototype'], projectStateSnapshot: null };

beforeEach(() => {
  vi.clearAllMocks();
  calls.save.mockReset().mockResolvedValue(goal);
  calls.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('opt-in meeting productivity', () => {
  it('keeps an existing goal readable without offering edit or removal', () => {
    render(<MeetingProductivitySection meetingId="meeting-1" goal={goal} productivity={null} />);
    expect(screen.getByText(goal.purpose)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar objetivo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover objetivo' })).toBeNull();
  });
  it('requires an expected outcome, saves the declared goal and refreshes analysis', async () => {
    render(<MeetingProductivitySection meetingId="meeting-1" goal={null} productivity={null} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Avaliar produtividade desta reunião' }));
    fireEvent.change(screen.getByLabelText(/Propósito da reunião/), { target: { value: goal.purpose } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar objetivo' }));
    expect(screen.getByRole('alert').textContent).toContain('Informe entre 1 e 10 outcomes');
    expect(calls.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Outcome esperado 1'), { target: { value: goal.expectedOutcomes[0] } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar objetivo' }));
    await screen.findByText('Aguardando análise…');
    expect(calls.save).toHaveBeenCalledWith('meeting-1', goal);
    expect(calls.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing goal when an edit is cancelled', () => {
    render(<MeetingProductivitySection meetingId="meeting-1" goal={goal} productivity={null} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar objetivo' }));
    fireEvent.change(screen.getByLabelText(/Propósito da reunião/), { target: { value: 'Unsaved scope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText(goal.purpose)).toBeTruthy();
    expect(screen.queryByText('Unsaved scope')).toBeNull();
    expect(calls.save).not.toHaveBeenCalled();
  });

  it('requires typed confirmation to remove a goal and allows retry after a permission error', async () => {
    calls.remove.mockRejectedValueOnce(new ApiRequestError(403, 'Permission denied'));
    render(<MeetingProductivitySection meetingId="meeting-1" goal={goal} productivity={null} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Remover objetivo' }));
    const remove = screen.getByRole('button', { name: 'Remover' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('REMOVER'), { target: { value: 'REMOVER' } });
    fireEvent.click(remove);
    await screen.findByText('Permission denied');
    expect(remove.disabled).toBe(false);
    expect(screen.getByText(goal.purpose)).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => expect(calls.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Avaliar produtividade desta reunião' })).toBeTruthy();
    expect(calls.remove).toHaveBeenCalledTimes(2);
  });
});
