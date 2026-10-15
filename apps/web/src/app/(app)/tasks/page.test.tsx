/** @vitest-environment jsdom */
import { Blob as NodeBlob } from 'node:buffer';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ListTasksParams, TaskListItemDto } from '@/lib/api/client';

const listTasks = vi.fn();
const updateTask = vi.fn();
const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
const permissions = vi.hoisted(() => ({ readTasks: true, writeTasks: true, createMeetings: true }));
vi.mock('@/components/enterprise/workspace-provider', () => ({
  useWorkspaceAccess: () => ({ access: { permissions }, loading: false }),
}));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  listTasks: (...args: unknown[]) => listTasks(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
}));

import TasksPage from './page';

let rows: TaskListItemDto[];
const createObjectURL = vi.fn();

function pagination() {
  return within(screen.getByRole('navigation', { name: 'Paginação de tarefas' }));
}

beforeEach(() => {
  navigation.query = '';
  permissions.readTasks = true;
  permissions.writeTasks = true;
  permissions.createMeetings = true;
  rows = Array.from({ length: 205 }, (_, i) => ({
    id: String(i + 1),
    title: `Task ${i + 1}`,
    status: 'OPEN',
    priority: 'HIGH',
    meetingId: 'meeting',
    meetingTitle: 'Review',
    updatedAt: '2026-10-14T12:00:00Z',
  }));
  listTasks
    .mockReset()
    .mockImplementation(async ({ status, page = 0, size = 100, meetingId }: ListTasksParams) => {
      const matching = rows
        .filter((row) => !status || row.status === status)
        .filter((row) => !meetingId || row.meetingId === meetingId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        items: matching.slice(page * size, (page + 1) * size),
        page,
        size,
        totalItems: matching.length,
        totalPages: Math.ceil(matching.length / size),
      };
    });
  updateTask.mockReset().mockImplementation(async (id: string, patch: Partial<TaskListItemDto>) => {
    rows = rows.map((row) =>
      row.id === id ? { ...row, ...patch, updatedAt: '2026-10-15T12:00:00Z' } : row,
    );
    return rows.find((row) => row.id === id);
  });
  createObjectURL.mockReset().mockReturnValue('blob:task-export');
  vi.stubGlobal('Blob', NodeBlob);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('keeps tasks and export readable without exposing write controls', async () => {
  permissions.writeTasks = false;
  permissions.createMeetings = false;
  rows = rows.slice(0, 3);
  render(<TasksPage />);
  await screen.findByText('Task 1');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
  expect(screen.queryByLabelText('Alterar status')).toBeNull();
  expect(screen.queryByLabelText(/Alterar data de vencimento/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Exportar' })).toBeTruthy();
  expect(updateTask).not.toHaveBeenCalled();
});

it('does not query tasks when the user lacks read access', () => {
  permissions.readTasks = false;
  render(<TasksPage />);
  expect(screen.getByText('Você não tem permissão para consultar tarefas neste workspace.')).toBeTruthy();
  expect(listTasks).not.toHaveBeenCalled();
});

it('keeps calendar deadlines on their declared day and does not mark today overdue', async () => {
  vi.stubEnv('TZ', 'America/Sao_Paulo');
  vi.setSystemTime(new Date('2026-10-14T18:00:00-03:00'));
  rows = rows.slice(0, 3);
  rows[0].dueDate = '2026-10-14';
  rows[1].dueDate = '2026-10-15';
  rows[2].dueDate = '2026-10-13';
  render(<TasksPage />);
  const today = await screen.findByText('vence hoje');
  expect(today.style.color).toBe('var(--muted)');
  expect(screen.getByText('vence amanhã')).toBeTruthy();
  expect(screen.getByText(/^venceu 13/)).toBeTruthy();
});

it('navigates beyond task 100, shows server totals and resets the page when filtering', async () => {
  rows[204].status = 'DONE';
  render(<TasksPage />);
  const allFilter = screen.getByRole('button', { name: 'Todas' });
  const doneFilter = screen.getByRole('button', { name: 'Concluídas' });
  await screen.findByText('Task 1');
  expect(allFilter.textContent).toContain('205');
  expect(screen.queryByText('Task 101')).toBeNull();
  fireEvent.click(pagination().getByRole('button', { name: 'Próxima' }));
  await screen.findByText('Task 101');
  expect(listTasks).toHaveBeenLastCalledWith({ status: undefined, page: 1, size: 100 });
  fireEvent.click(doneFilter);
  await screen.findByText('Task 205');
  expect(listTasks).toHaveBeenLastCalledWith({ status: 'DONE', page: 0, size: 100 });
  expect(doneFilter.textContent).toContain('1');
  expect(screen.queryByText('Task 101')).toBeNull();
});

it('moves to the previous page when completing the last result of a filtered page', async () => {
  rows = rows.slice(0, 101);
  render(<TasksPage />);
  const openFilter = screen.getByRole('button', { name: 'Abertas' });
  await screen.findByText('Task 1');
  fireEvent.click(openFilter);
  await waitFor(() => expect(openFilter.textContent).toContain('101'));
  fireEvent.click(pagination().getByRole('button', { name: 'Próxima' }));
  await screen.findByText('Task 101');
  fireEvent.click(screen.getByRole('checkbox'));
  await screen.findByText('Task 1');
  expect(openFilter.textContent).toContain('100');
  expect(screen.queryByText('Task 101')).toBeNull();
  expect(listTasks).toHaveBeenLastCalledWith({ status: 'OPEN', page: 0, size: 100 });
});

it('downloads all filtered tasks when exporting from a later page', async () => {
  render(<TasksPage />);
  const exportButton = screen.getByRole('button', { name: 'Exportar' });
  await screen.findByText('Task 1');
  fireEvent.click(pagination().getByRole('button', { name: 'Próxima' }));
  await screen.findByText('Task 101');
  fireEvent.click(exportButton);
  fireEvent.click(screen.getByRole('menuitem', { name: 'CSV (.csv)' }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  const csv = await (createObjectURL.mock.calls[0][0] as NodeBlob).text();
  expect(csv).toContain('Task 1,');
  expect(csv).toContain('Task 101,');
  expect(csv).toContain('Task 205,');
  expect(listTasks).toHaveBeenLastCalledWith({ status: undefined, page: 2, size: 100 });
});

it('shows an export error and downloads nothing if a later page fails', async () => {
  render(<TasksPage />);
  const exportButton = screen.getByRole('button', { name: 'Exportar' });
  await screen.findByText('Task 1');
  listTasks.mockRejectedValueOnce(new Error('Export unavailable'));
  fireEvent.click(exportButton);
  fireEvent.click(screen.getByRole('menuitem', { name: 'CSV (.csv)' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Export unavailable');
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('refreshes server ordering after editing a task on a later page', async () => {
  render(<TasksPage />);
  await screen.findByText('Task 1');
  fireEvent.click(pagination().getByRole('button', { name: 'Próxima' }));
  await screen.findByText('Task 101');
  const taskRow = screen.getByLabelText('Marcar "Task 101" como concluída')
    .parentElement as HTMLElement;
  fireEvent.click(within(taskRow).getByRole('button', { name: 'Editar' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Título' }), { target: { value: 'Updated task' } });
  fireEvent.click(within(taskRow).getByRole('button', { name: 'Salvar' }));
  await screen.findByText('Task 100');
  expect(screen.queryByText('Updated task')).toBeNull();
  fireEvent.click(pagination().getByRole('button', { name: 'Anterior' }));
  expect(await screen.findByText('Updated task')).toBeTruthy();
});

it('keeps meeting scope and its evidence when editing the responsible person and exporting', async () => {
  navigation.query = 'meetingId=meeting';
  rows = rows.slice(0, 2);
  rows[0].sourceQuote = 'Speaker 1: I will review the proposal.';
  rows[1].meetingId = 'another-meeting';
  render(<TasksPage />);
  await screen.findByText('Task 1');
  expect(screen.queryByText('Task 2')).toBeNull();
  expect(screen.getByText('Speaker 1: I will review the proposal.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Responsável' }), { target: { value: '  Marina  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await screen.findByText('Marina');
  expect(updateTask).toHaveBeenLastCalledWith('1', { assignee: 'Marina' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Exportar' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'CSV (.csv)' }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
  const csv = await (createObjectURL.mock.calls[0][0] as NodeBlob).text();
  expect(csv).toContain('Marina');
  expect(csv).not.toContain('Task 2');
  expect(listTasks).toHaveBeenLastCalledWith({ status: undefined, page: 0, size: 100, meetingId: 'meeting' });
});

it('restores the responsible person when an update fails and allows explicitly clearing it', async () => {
  rows = rows.slice(0, 1);
  rows[0].assignee = 'Marina';
  render(<TasksPage />);
  await screen.findByText('Marina');
  updateTask.mockRejectedValueOnce(new Error('Unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Responsável' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Marina')).toBeTruthy();
  expect(updateTask).toHaveBeenLastCalledWith('1', { assignee: '' });
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Responsável' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  expect(await screen.findByText('Sem responsável')).toBeTruthy();
});

it('distinguishes a load failure from an empty list and retries the current page', async () => {
  listTasks.mockRejectedValueOnce(new Error('Temporary outage'));
  render(<TasksPage />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Nenhuma tarefa.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  expect(await screen.findByText('Task 1')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
