/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportedTranscript, TranscriptImport } from '@/lib/transcript-import';

const mocks = vi.hoisted(() => ({ parse: vi.fn(), upload: vi.fn(), meeting: vi.fn(), reprocess: vi.fn() }));
vi.mock('@/lib/transcript-import', () => ({ MAX_IMPORT_BYTES: 64 * 1024 * 1024, parseTranscriptImport: mocks.parse }));
vi.mock('@/lib/api/client', async (original) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await original<typeof import('@/lib/api/client')>()),
  uploadMeeting: mocks.upload,
  getMeeting: mocks.meeting,
  reprocessMeeting: mocks.reprocess,
}));
import { StructuredTranscriptImport } from './structured-transcript-import';

function record(id: number): ImportedTranscript {
  return { sourceId: `source-${id}`, clientCode: 'C-42', title: `Meeting ${id}`, text: `Full transcript ${id}`,
    startedAt: '2026-10-15T09:00:00-03:00', attributes: { externalId: `source-${id}`, clientCode: 'C-42' }, idempotencyKey: `import:v1:hash-${id}` };
}
function parsed(records = [record(1), record(2)]): TranscriptImport {
  return { records, duplicates: 1, issues: [{ row: 4, message: 'Missing transcript' }], totalRows: records.length + 2, warnings: ['Encoding repaired'] };
}
function chooseFile(file = new File(['{}'], 'meetings.json', { type: 'application/json' })) {
  fireEvent.change(screen.getByLabelText('Arquivo de reuniões'), { target: { files: [file] } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockReset().mockResolvedValue(parsed());
  mocks.upload.mockReset().mockResolvedValue({ id: 'meeting-created', processingStatus: 'PENDING' });
  mocks.meeting.mockReset().mockResolvedValue({ processingStatus: 'COMPLETED' });
  mocks.reprocess.mockReset().mockResolvedValue({ id: 'meeting-created', processingStatus: 'PENDING' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('requires an explicit selection and sends only the chosen transcript with its identifiers', async () => {
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Escolher arquivo' })).toBeTruthy();
  chooseFile();
  await screen.findByText('Meeting 1');
  expect(screen.getByRole('button', { name: 'Trocar arquivo' })).toBeTruthy();
  expect(screen.getByText('meetings.json')).toBeTruthy();
  expect(screen.getByText('4 registros · 2 válidos · 1 repetidos · 1 inválidos')).toBeTruthy();
  expect(screen.getByText('Encoding repaired')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Importar 0 reuniões' }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Meeting 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 1 reunião' }));
  await screen.findByText('1 de 1 análise concluída');
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ title: 'Meeting 2', transcriptFormat: 'TXT', startedAt: '2026-10-15T09:00:00-03:00', attributes: record(2).attributes, idempotencyKey: record(2).idempotencyKey }));
  const sentFile = mocks.upload.mock.calls[0][0].file as File;
  expect(sentFile.size).toBe(new Blob([record(2).text]).size);
  expect(screen.getByRole('link', { name: 'Abrir reunião' }).getAttribute('href')).toBe('/meetings/meeting-created');
});

it('holds both slots through analysis and starts a third upload only after completion', async () => {
  const first = deferred<{ processingStatus: string }>();
  const second = deferred<{ processingStatus: string }>();
  mocks.parse.mockResolvedValue(parsed([record(1), record(2), record(3)]));
  mocks.upload.mockImplementation(async ({ title }) => ({ id: title }));
  mocks.meeting.mockImplementation((id) => id === 'Meeting 1' ? first.promise : id === 'Meeting 2' ? second.promise : Promise.resolve({ processingStatus: 'COMPLETED' }));
  const onBusyChange = vi.fn();
  render(<StructuredTranscriptImport onBusyChange={onBusyChange} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (3)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 3 reuniões' }));
  await waitFor(() => expect(mocks.meeting).toHaveBeenCalledTimes(2));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('Analisando…')).toHaveLength(2);
  expect(screen.getByText('Na fila')).toBeTruthy();
  expect(screen.getByText('0 de 3 análises concluídas')).toBeTruthy();
  await act(async () => first.resolve({ processingStatus: 'COMPLETED' }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3));
  await act(async () => second.resolve({ processingStatus: 'COMPLETED' }));
  await screen.findByText('3 de 3 análises concluídas');
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it('checks a failed analysis again and reprocesses its existing meeting without uploading it twice', async () => {
  mocks.parse.mockResolvedValue(parsed([record(1)]));
  mocks.meeting.mockResolvedValueOnce({ processingStatus: 'FAILED' }).mockResolvedValueOnce({ processingStatus: 'FAILED' }).mockResolvedValue({ processingStatus: 'COMPLETED' });
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} canReprocess />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (1)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 1 reunião' }));
  await screen.findByText('A análise falhou.');
  expect(mocks.reprocess).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Tentar falhas novamente' })));
  expect(mocks.meeting).toHaveBeenCalledTimes(2);
  expect(mocks.reprocess).toHaveBeenCalledExactlyOnceWith('meeting-created');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText('1 de 1 análise concluída')).toBeTruthy();
  expect(mocks.upload).toHaveBeenCalledTimes(1);
});

it('does not offer paid reprocessing without the matching permission', async () => {
  mocks.parse.mockResolvedValue(parsed([record(1)]));
  mocks.meeting.mockResolvedValue({ processingStatus: 'FAILED' });
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (1)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 1 reunião' }));
  await screen.findByText('A análise falhou.');
  expect(screen.queryByRole('button', { name: 'Tentar falhas novamente' })).toBeNull();
  expect(mocks.reprocess).not.toHaveBeenCalled();
});

it('pauses unsent records, guards leaving the page and resumes after active analyses finish', async () => {
  const pending = deferred<{ processingStatus: string }>();
  mocks.parse.mockResolvedValue(parsed([record(1), record(2), record(3)]));
  mocks.meeting.mockReturnValueOnce(pending.promise).mockReturnValueOnce(pending.promise).mockResolvedValue({ processingStatus: 'COMPLETED' });
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (3)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 3 reuniões' }));
  await waitFor(() => expect(mocks.meeting).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Pausar fila' }));
  await act(async () => pending.resolve({ processingStatus: 'COMPLETED' }));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Retomar fila' }));
  await screen.findByText('3 de 3 análises concluídas');
  expect(mocks.upload).toHaveBeenCalledTimes(3);
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
});

it('stops starting work after unmount even when accepted upload responses arrive later', async () => {
  const pending = deferred<{ id: string }>();
  mocks.parse.mockResolvedValue(parsed([record(1), record(2), record(3)]));
  mocks.upload.mockReturnValue(pending.promise);
  const view = render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (3)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Importar 3 reuniões' }));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => pending.resolve({ id: 'already-accepted' }));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.meeting).not.toHaveBeenCalled();
  expect(mocks.reprocess).not.toHaveBeenCalled();
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
});

it('pauses after repeated status request failures and consults existing meetings before resuming uploads', async () => {
  mocks.parse.mockResolvedValue(parsed([record(1), record(2), record(3)]));
  mocks.meeting.mockRejectedValue(new Error('offline'));
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} canReprocess />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (3)' }));
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Importar 3 reuniões' })));
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('Status não confirmado. Consulte novamente antes de continuar.')).toHaveLength(2);
  mocks.meeting.mockResolvedValue({ processingStatus: 'COMPLETED' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Consultar e retomar' })));
  expect(screen.getByText('3 de 3 análises concluídas')).toBeTruthy();
  expect(mocks.upload).toHaveBeenCalledTimes(3);
  expect(mocks.reprocess).not.toHaveBeenCalled();
});

it('reports an analysis timeout honestly and checks its status again without reprocessing', async () => {
  mocks.parse.mockResolvedValue(parsed([record(1)]));
  mocks.meeting.mockResolvedValue({ processingStatus: 'PROCESSING' });
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} canReprocess />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (1)' }));
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Importar 1 reunião' })));
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(screen.getByText('Status não confirmado. Consulte novamente antes de continuar.')).toBeTruthy();
  expect(screen.getByText('0 de 1 análise concluída')).toBeTruthy();
  mocks.meeting.mockResolvedValue({ processingStatus: 'COMPLETED' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Consultar e retomar' })));
  expect(screen.getByText('1 de 1 análise concluída')).toBeTruthy();
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(mocks.reprocess).not.toHaveBeenCalled();
});

it('replays a timed-out upload with the same key instead of creating a new import identity', async () => {
  mocks.parse.mockResolvedValue(parsed([record(1)]));
  mocks.upload.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ id: 'accepted-before-timeout' });
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar todas (1)' }));
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Importar 1 reunião' })));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByText('Envio não confirmado. Retome para verificar sem duplicar a reunião.')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Consultar e retomar' })));
  expect(screen.getByText('1 de 1 análise concluída')).toBeTruthy();
  expect(mocks.upload.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([record(1).idempotencyKey, record(1).idempotencyKey]);
  expect(mocks.reprocess).not.toHaveBeenCalled();
});

it('retains selection across preview pages and selects every record explicitly', async () => {
  mocks.parse.mockResolvedValue(parsed(Array.from({ length: 51 }, (_, index) => record(index + 1))));
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  chooseFile();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar Meeting 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Meeting 51' }));
  expect(screen.getByRole('button', { name: 'Importar 2 reuniões' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
  expect((screen.getByRole('checkbox', { name: 'Selecionar Meeting 1' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas (51)' }));
  expect(screen.getByRole('button', { name: 'Importar 51 reuniões' })).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: 'Páginas da importação' })).getByText('1 de 2')).toBeTruthy();
});

it('refuses oversized input before parsing and recovers from a parse failure', async () => {
  render(<StructuredTranscriptImport onBusyChange={vi.fn()} />);
  const oversized = new File(['{}'], 'large.json');
  Object.defineProperty(oversized, 'size', { value: 65 * 1024 * 1024 });
  chooseFile(oversized);
  expect(screen.getByRole('alert').textContent).toContain('64 MB');
  expect(mocks.parse).not.toHaveBeenCalled();
  mocks.parse.mockRejectedValueOnce(new Error('Invalid JSON'));
  chooseFile();
  await screen.findByText('Invalid JSON');
  chooseFile();
  await screen.findByText('Meeting 1');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(mocks.upload).not.toHaveBeenCalled();
});
