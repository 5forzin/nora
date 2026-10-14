/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ upload: vi.fn(), meeting: vi.fn(), flows: vi.fn(), split: vi.fn() }));
const permissions = vi.hoisted(() => ({ createMeetings: true, readFlows: true, manageFlows: true }));
vi.mock('@/components/enterprise/workspace-provider', () => ({
  useWorkspaceAccess: () => ({ access: { permissions }, loading: false }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock('@/lib/api/client', async (original) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await original<typeof import('@/lib/api/client')>()),
  uploadMeeting: api.upload,
  getMeeting: api.meeting,
  listWorkflows: api.flows,
  splitPreview: api.split,
}));

import UploadMeetingPage from './page';
import { ApiRequestError } from '@/lib/api/client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function selectFiles(...files: File[]) {
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } });
}

function file(text = 'Project meeting', name = 'project.txt') {
  const value = new File([text], name, { type: 'text/plain' });
  Object.defineProperty(value, 'text', { value: vi.fn().mockResolvedValue(text) });
  return value;
}

beforeEach(() => {
  permissions.createMeetings = true;
  permissions.readFlows = true;
  permissions.manageFlows = true;
  vi.clearAllMocks();
  api.upload.mockReset().mockResolvedValue({ id: 'meeting-1', processingStatus: 'PENDING' });
  api.meeting.mockReset().mockResolvedValue({ processingStatus: 'COMPLETED' });
  api.flows.mockReset().mockResolvedValue([]);
  api.split.mockReset().mockResolvedValue({ segments: [
    { index: 0, title: 'Project', startLine: 1, endLine: 2, confidence: 0.9, preview: 'First meeting' },
    { index: 1, title: 'Project', startLine: 3, endLine: 4, confidence: 0.9, preview: 'Second meeting' },
  ] });
});
afterEach(cleanup);

it('denies a direct upload route without mounting the form for a read-only user', () => {
  permissions.createMeetings = false;
  render(<UploadMeetingPage />);
  expect(screen.getByText('Você não tem permissão para enviar reuniões neste workspace.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enviar e analisar' })).toBeNull();
  expect(api.upload).not.toHaveBeenCalled();
});

describe('individual transcript upload', () => {
  it('submits the selected format and local dates, then links to the completed analysis', async () => {
    render(<UploadMeetingPage />);
    const transcript = file('WEBVTT\n\n00:00.000 --> 00:01.000\nApproved.', 'client.vtt');
    selectFiles(transcript);
    fireEvent.change(screen.getByLabelText(/Título/), { target: { value: 'Client / October' } });
    fireEvent.change(screen.getByLabelText('Início da reunião'), { target: { value: '2026-10-14T10:00' } });
    fireEvent.change(screen.getByLabelText('Término'), { target: { value: '2026-10-14T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar e analisar' }));
    await screen.findByRole('link', { name: 'Ver análise' });
    expect(api.upload).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Client / October', transcriptFormat: 'VTT', file: transcript,
      startedAt: new Date('2026-10-14T10:00').toISOString(),
      endedAt: new Date('2026-10-14T10:30').toISOString(),
    }));
    expect(screen.getByRole('link', { name: 'Ver análise' }).getAttribute('href')).toBe('/meetings/meeting-1');
  });

  it('keeps a pending workflow lookup alive when analysis polling finishes', async () => {
    const flows = deferred<{ active: boolean; triggerType: string }[]>();
    api.flows.mockReturnValue(flows.promise);
    render(<UploadMeetingPage />);
    selectFiles(file());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar e analisar' }));
    await screen.findByRole('link', { name: 'Ver análise' });
    await act(async () => flows.resolve([{ active: true, triggerType: 'meeting.analysis_completed' }]));
    expect(await screen.findByText('Seus fluxos ativos serão executados quando a análise terminar.')).toBeTruthy();
    expect(api.flows).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized files before upload and leaves a usable form', async () => {
    render(<UploadMeetingPage />);
    const oversized = file();
    Object.defineProperty(oversized, 'size', { value: 11 * 1024 * 1024 });
    selectFiles(oversized);
    expect(screen.getByRole('alert').textContent).toContain('limite é 10 MB');
    expect(api.upload).not.toHaveBeenCalled();
    selectFiles(file());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar e analisar' }));
    await screen.findByRole('link', { name: 'Ver análise' });
    expect(api.upload).toHaveBeenCalledTimes(1);
  });
});

describe('batch and split upload', () => {
  it('retries only the failed batch member and resolves the workflow hint after progress updates', async () => {
    const flows = deferred<[]>();
    api.flows.mockReturnValue(flows.promise);
    api.upload.mockResolvedValueOnce({ id: 'first' }).mockRejectedValueOnce(new ApiRequestError(503, 'Temporarily unavailable'));
    render(<UploadMeetingPage />);
    const first = file('First', 'first.txt');
    const second = file('Second', 'second.srt');
    selectFiles(first, second);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar 2 transcrições' }));
    await screen.findByText('1 transcrição enviada.');
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    await screen.findByText('2 transcrições enviadas.');
    await act(async () => flows.resolve([]));
    expect(await screen.findByRole('link', { name: 'Fluxos' })).toBeTruthy();
    expect(api.upload).toHaveBeenCalledTimes(3);
    expect(api.upload.mock.calls.map(([request]) => request.file.name)).toEqual(['first.txt', 'second.srt', 'second.srt']);
  });

  it('splits the confirmed line ranges into distinct safe files', async () => {
    render(<UploadMeetingPage />);
    selectFiles(file('First\r\nDecision one\r\nSecond\r\nDecision two'));
    fireEvent.click(screen.getByRole('checkbox', { name: /separar automaticamente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Analisar e separar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Criar 2 reuniões' }));
    await screen.findByText('2 transcrições enviadas.');
    const files = api.upload.mock.calls.map(([request]) => request.file as File);
    expect(files.map((item) => item.name)).toEqual(['project.txt', 'project-2.txt']);
    const contents = await Promise.all(files.map((item) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(item);
    })));
    expect(contents).toEqual(['First\nDecision one', 'Second\nDecision two']);
  });

  it('returns to the form when the selected split file cannot be read', async () => {
    render(<UploadMeetingPage />);
    const unreadable = file();
    vi.mocked(unreadable.text).mockRejectedValue(new Error('File unavailable'));
    selectFiles(unreadable);
    fireEvent.click(screen.getByRole('checkbox', { name: /separar automaticamente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Analisar e separar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Criar 2 reuniões' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Não foi possível ler o arquivo'));
    expect(screen.getByRole('button', { name: 'Analisar e separar' })).toBeTruthy();
    expect(api.upload).not.toHaveBeenCalled();
  });
});
