/**
 * @vitest-environment jsdom
 *
 * The last hop of the landing's promise, and the chat's answer to a refusal.
 *
 * The landing invites a visitor to type a question into its hero composer and carries it as `?q=`
 * all the way through signup. This page read `?s=` and nothing else, so the parameter arrived here
 * and was dropped: the product asked somebody to start typing and then showed them an empty box.
 *
 * The other half is 429. `/api/chat` has a per-principal request budget and the semantic search
 * behind it answers `MEETING_RATE_LIMITED`; both used to be wrapped in "não consegui responder
 * agora (…)", which reports a working limit as a malfunction.
 *
 * The orb and the markdown renderer are stubbed — they bring a shader and a parser and neither has
 * anything to say about either behaviour. Elements are reached by role and by class, never by
 * caption: the captions are pt-BR product copy.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
  useSearchParams: () => params,
}));

vi.mock('@/components/brand/shader-orb', () => ({ ShaderOrb: () => null }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="answer">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => undefined }));

const streamChat = vi.fn();
const createChatSession = vi.fn();
const appendChatMessage = vi.fn();
const getChatSession = vi.fn();
const getMe = vi.fn();
vi.mock('@/lib/api/client', async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  streamChat: (...a: unknown[]) => streamChat(...a),
  createChatSession: (...a: unknown[]) => createChatSession(...a),
  appendChatMessage: (...a: unknown[]) => appendChatMessage(...a),
  getChatSession: (...a: unknown[]) => getChatSession(...a),
  getMe: () => getMe(),
}));

import ChatPage from '@/app/(app)/chat/page';
import { errorCopy } from '@/lib/strings';
import { WorkspaceProvider } from '@/components/enterprise/workspace-provider';
import { readerWorkspace } from '@/fixtures/workspace-access';

function renderChat() {
  return render(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
}

function composer(): HTMLTextAreaElement {
  return document.querySelector('textarea') as HTMLTextAreaElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function answerStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: new Response(body),
    append: (text: string) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ t: 'c', c: text })}\n`)),
    close: () => controller.close(),
    abort: () => controller.error(new DOMException('Aborted', 'AbortError')),
  };
}

function sendQuestion(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: 'Enter' });
}

function conversation() {
  return screen.getByRole('log', { name: 'Conversa com a Nora' });
}

beforeEach(() => {
  params = new URLSearchParams();
  replace.mockReset();
  push.mockReset();
  streamChat.mockReset();
  createChatSession.mockReset().mockResolvedValue({ id: 's-1', title: 'Nova sessão' });
  appendChatMessage.mockReset().mockResolvedValue(undefined);
  getChatSession.mockReset().mockResolvedValue({ title: 'Sessão', messages: [] });
  getMe.mockReset().mockResolvedValue(readerWorkspace);
});

afterEach(cleanup);

describe('the complete chat turn lifecycle', () => {
  it('locks synchronous submissions before creation and keeps message writes ordered through final persistence', async () => {
    const creation = deferred<{ id: string }>();
    const userWrite = deferred<void>();
    const assistantWrite = deferred<void>();
    createChatSession.mockReturnValueOnce(creation.promise);
    appendChatMessage.mockReturnValueOnce(userWrite.promise).mockReturnValueOnce(assistantWrite.promise);
    const first = answerStream();
    first.append('First answer');
    first.close();
    const second = answerStream();
    second.append('Second answer');
    second.close();
    streamChat.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    renderChat();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    fireEvent.change(composer(), { target: { value: 'First question' } });
    const suggestion = screen.getByRole('button', { name: 'Resuma minha última reunião' });
    act(() => {
      fireEvent.keyDown(composer(), { key: 'Enter' });
      fireEvent.keyDown(composer(), { key: 'Enter' });
      fireEvent.click(suggestion);
    });
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect((suggestion as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull();

    await act(async () => { creation.resolve({ id: 's-1' }); });
    expect(appendChatMessage).toHaveBeenCalledTimes(1);
    expect(conversation().getAttribute('aria-busy')).toBe('true');
    expect(composer().disabled).toBe(true);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(streamChat).not.toHaveBeenCalled();

    await act(async () => { userWrite.resolve(); });
    await vi.waitFor(() => expect(appendChatMessage).toHaveBeenCalledTimes(2));
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(conversation().getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Limpar' }) as HTMLButtonElement).disabled).toBe(true);
    sendQuestion('Second question');
    expect(appendChatMessage).toHaveBeenCalledTimes(2);
    expect(appendChatMessage.mock.calls.map(([, value]) => value.role)).toEqual(['user', 'assistant']);

    await act(async () => { assistantWrite.resolve(); });
    expect(conversation().getAttribute('aria-busy')).toBe('false');
    expect(composer().disabled).toBe(false);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await vi.waitFor(() => expect(appendChatMessage).toHaveBeenCalledTimes(4));
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(appendChatMessage.mock.calls.map(([, value]) => value.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it('does not hydrate over a locally created session while its answer is streaming', async () => {
    const stream = answerStream();
    streamChat.mockResolvedValue(stream.response);
    const view = renderChat();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    sendQuestion('Keep this question');
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => { stream.append('Keep this answer'); });
    params = new URLSearchParams({ s: 's-1' });
    view.rerender(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
    expect(getChatSession).not.toHaveBeenCalled();
    expect(conversation().textContent).toContain('Keep this question');
    expect(conversation().textContent).toContain('Keep this answer');
    expect(streamChat.mock.calls[0][1].aborted).toBe(false);
    await act(async () => { stream.close(); });
    expect(appendChatMessage).toHaveBeenLastCalledWith('s-1', { role: 'assistant', content: 'Keep this answer' });
  });

  it('only offers stop for a cancelable stream and holds the retry lock until its answer is saved', async () => {
    const first = answerStream();
    const second = answerStream();
    streamChat.mockImplementationOnce((_, signal: AbortSignal) => {
      signal.addEventListener('abort', first.abort, { once: true });
      return Promise.resolve(first.response);
    }).mockResolvedValueOnce(second.response);
    renderChat();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    sendQuestion('One question');
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => { first.append('Partial answer'); });
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await vi.waitFor(() => expect(conversation().getAttribute('aria-busy')).toBe('false'));
    expect(streamChat.mock.calls[0][1].aborted).toBe(true);
    expect(appendChatMessage).toHaveBeenLastCalledWith('s-1', { role: 'assistant', content: 'Partial answer' });

    const retryWrite = deferred<void>();
    appendChatMessage.mockReturnValueOnce(retryWrite.promise);
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(streamChat).toHaveBeenCalledTimes(2);
    await act(async () => { second.append('Retried answer'); second.close(); });
    expect(appendChatMessage).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull();
    expect(conversation().getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(streamChat).toHaveBeenCalledTimes(2);
    await act(async () => { retryWrite.resolve(); });
    expect(conversation().getAttribute('aria-busy')).toBe('false');
    expect(createChatSession).toHaveBeenCalledTimes(1);
  });

  it('discards a late session creation after navigation', async () => {
    const creation = deferred<{ id: string }>();
    createChatSession.mockReturnValueOnce(creation.promise);
    getChatSession.mockResolvedValue({ title: 'Other session', messages: [{ role: 'assistant', content: 'Other answer' }] });
    const view = renderChat();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    sendQuestion('Do not follow me');
    params = new URLSearchParams({ s: 'other-session' });
    view.rerender(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
    await screen.findByText('Other answer');
    await act(async () => { creation.resolve({ id: 'late-session' }); });
    expect(replace).not.toHaveBeenCalled();
    expect(appendChatMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
    expect(conversation().textContent).toBe('Other answer');
  });

  it('does not start an obsolete stream or release a newer turn after a delayed user append', async () => {
    params = new URLSearchParams({ s: 'first-session' });
    const firstWrite = deferred<void>();
    appendChatMessage.mockReturnValueOnce(firstWrite.promise);
    const stream = answerStream();
    streamChat.mockResolvedValue(stream.response);
    const view = renderChat();
    await vi.waitFor(() => expect(composer()?.disabled).toBe(false));
    sendQuestion('Old question');
    params = new URLSearchParams({ s: 'second-session' });
    view.rerender(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
    await vi.waitFor(() => expect(composer().disabled).toBe(false));
    sendQuestion('New question');
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => { firstWrite.resolve(); });
    expect(conversation().getAttribute('aria-busy')).toBe('true');
    expect(conversation().textContent).toContain('New question');
    expect(conversation().textContent).not.toContain('Old question');
    expect(streamChat).toHaveBeenCalledTimes(1);
    await act(async () => { stream.append('New answer'); stream.close(); });
    expect(appendChatMessage.mock.calls.map(([id, value]) => [id, value.role])).toEqual([
      ['first-session', 'user'], ['second-session', 'user'], ['second-session', 'assistant'],
    ]);
  });

  it.each(['navigate', 'unmount'])('aborts and ignores late stream output on %s', async (action) => {
    params = new URLSearchParams({ s: 'first-session' });
    const stream = answerStream();
    streamChat.mockResolvedValue(stream.response);
    const view = renderChat();
    await vi.waitFor(() => expect(composer()?.disabled).toBe(false));
    sendQuestion('Old question');
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => { stream.append('Old partial answer'); });
    if (action === 'navigate') {
      getChatSession.mockResolvedValue({ title: 'Other session', messages: [{ role: 'assistant', content: 'Other answer' }] });
      params = new URLSearchParams({ s: 'other-session' });
      view.rerender(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
      await screen.findByText('Other answer');
    } else view.unmount();
    expect(streamChat.mock.calls[0][1].aborted).toBe(true);
    await act(async () => { stream.append('Late answer'); stream.close(); });
    expect(appendChatMessage).toHaveBeenCalledTimes(1);
    expect(appendChatMessage).toHaveBeenCalledWith('first-session', { role: 'user', content: 'Old question' });
    if (action === 'navigate') expect(conversation().textContent).toBe('Other answer');
  });

  it('keeps an in-progress assistant append bound to its original session and ignores its late error', async () => {
    params = new URLSearchParams({ s: 'first-session' });
    const assistantWrite = deferred<void>();
    appendChatMessage.mockResolvedValueOnce(undefined).mockReturnValueOnce(assistantWrite.promise);
    const stream = answerStream();
    stream.append('Old answer');
    stream.close();
    streamChat.mockResolvedValue(stream.response);
    const view = renderChat();
    await vi.waitFor(() => expect(composer()?.disabled).toBe(false));
    sendQuestion('Old question');
    await vi.waitFor(() => expect(appendChatMessage).toHaveBeenCalledTimes(2));
    getChatSession.mockResolvedValue({ title: 'Other session', messages: [{ role: 'assistant', content: 'Other answer' }] });
    params = new URLSearchParams({ s: 'other-session' });
    view.rerender(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
    await screen.findByText('Other answer');
    await act(async () => { assistantWrite.reject(new Error('Late write failure')); });
    expect(appendChatMessage).toHaveBeenLastCalledWith('first-session', { role: 'assistant', content: 'Old answer' });
    expect(conversation().textContent).toBe('Other answer');
    expect(conversation().getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText('Esta conversa não está sendo salva')).toBeNull();
  });
});

describe('meeting access', () => {
  it('keeps the composer available to a reader without meeting or task write permissions', async () => {
    renderChat();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    expect(readerWorkspace.permissions.createMeetings).toBe(false);
    expect(readerWorkspace.permissions.writeTasks).toBe(false);
  });

  it('does not load saved conversations for an administrator without meeting read access', async () => {
    params = new URLSearchParams({ s: 'saved-session' });
    getMe.mockResolvedValue({
      ...readerWorkspace,
      capabilities: { ...readerWorkspace.capabilities, manageUsers: true, manageAccess: true, viewExecutiveOverview: false },
      permissions: { ...readerWorkspace.permissions, readMeetings: false },
    });
    renderChat();
    await screen.findByText('Você não tem permissão para consultar reuniões neste workspace.');
    expect(composer()).toBeNull();
    expect(getChatSession).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('keeps chat unavailable when permission metadata is missing', async () => {
    getMe.mockResolvedValue({ ...readerWorkspace, permissions: undefined });
    renderChat();
    await screen.findByText('Você não tem permissão para consultar reuniões neste workspace.');
    expect(composer()).toBeNull();
    expect(createChatSession).not.toHaveBeenCalled();
  });
});

describe('the question carried over from the landing', () => {
  it('seeds the composer from ?q= instead of dropping it', async () => {
    params = new URLSearchParams({ q: 'O que ficou pendente esta semana?' });
    renderChat();

    await vi.waitFor(() => expect(composer()?.value).toBe('O que ficou pendente esta semana?'));
  });

  it('does not send it by itself — a link must not spend an LLM call on its own', async () => {
    params = new URLSearchParams({ q: 'Resuma minha última reunião' });
    renderChat();

    await vi.waitFor(() => expect(composer().value).not.toBe(''));
    expect(streamChat).not.toHaveBeenCalled();
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('takes the parameter out of the URL, so a reload does not overwrite what was typed', async () => {
    params = new URLSearchParams({ q: 'Quais riscos apareceram?' });
    renderChat();

    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0][0]).toBe('/chat');
  });

  it('leaves an existing conversation alone: ?s= means they came back to a session', async () => {
    params = new URLSearchParams({ s: 'sess-9', q: 'pergunta antiga' });
    renderChat();

    await vi.waitFor(() => expect(getChatSession).toHaveBeenCalledWith('sess-9'));
    expect(composer().value).toBe('');
    expect(replace.mock.calls[0][0]).toBe('/chat?s=sess-9');
  });

  it('does nothing at all without the parameter', async () => {
    renderChat();

    await vi.waitFor(() => expect(composer()).not.toBeNull());
    expect(composer().value).toBe('');
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('a chat turn the backend refused for budget reasons', () => {
  /** Types a question and sends it. */
  async function ask() {
    await vi.waitFor(() => expect(composer()).not.toBeNull());
    fireEvent.change(composer(), { target: { value: 'oi' } });
    fireEvent.submit(composer().closest('form') ?? composer());
    fireEvent.keyDown(composer(), { key: 'Enter' });
  }

  it('says the limit plainly, with no "algo falhou" wrapper around it', async () => {
    streamChat.mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      json: async () => ({}),
    });
    renderChat();
    await ask();

    const answer = await vi.waitFor(() => screen.getByTestId('answer'));
    expect(answer.textContent).toBe(errorCopy.MEETING_RATE_LIMITED);
  });

  it('prefers the message the route sent, when it sent one', async () => {
    streamChat.mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      json: async () => ({ error: 'Muitas mensagens em pouco tempo.' }),
    });
    renderChat();
    await ask();

    const answer = await vi.waitFor(() => screen.getByTestId('answer'));
    expect(answer.textContent).toBe('Muitas mensagens em pouco tempo.');
  });

  it('still wraps any other failure, which IS a malfunction', async () => {
    streamChat.mockResolvedValue({
      ok: false,
      status: 502,
      body: null,
      json: async () => ({ error: 'Provedor indisponível.' }),
    });
    renderChat();
    await ask();

    const answer = await vi.waitFor(() => screen.getByTestId('answer'));
    expect(answer.textContent).toContain('Provedor indisponível.');
    expect(answer.textContent).not.toBe('Provedor indisponível.');
  });
});
