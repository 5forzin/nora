/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readerWorkspace } from '@/fixtures/workspace-access';
import { WorkspaceProvider } from '@/components/enterprise/workspace-provider';

const ID = '12345678-9012-4012-8012-123456789012';
const params = new URLSearchParams({ s: 'saved-conversation' });
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => params,
}));
vi.mock('@/components/brand/shader-orb', () => ({ ShaderOrb: () => null }));
vi.mock('@/lib/api/client', () => ({
  getMe: async () => readerWorkspace,
  appendChatMessage: vi.fn(),
  createChatSession: vi.fn(),
  streamChat: vi.fn(),
  getChatSession: async () => ({
    title: 'Executive review',
    messages: [{ role: 'assistant', content: `Renewal is at risk. [Renewal review](/meetings/${ID})` }],
  }),
}));

import ChatPage from './page';

afterEach(cleanup);

it('renders persisted meeting citations as links to the actual meeting route', async () => {
  render(<WorkspaceProvider><ChatPage /></WorkspaceProvider>);
  const source = await screen.findByRole('link', { name: 'Renewal review' });
  expect(source.getAttribute('href')).toBe(`/meetings/${ID}`);
});
