/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntegrationStatus } from '@/lib/api/types';
import { strings } from '@/lib/strings';
import { BlockPalette } from './block-palette';
import { CATALOG } from './catalog';

afterEach(cleanup);
const status = (provider: IntegrationStatus['provider'], configured = true, connected = true): IntegrationStatus =>
  ({ provider, configured, connected, externalAccount: null, connectedAt: null });

function palette(integrations: IntegrationStatus[] | null, integrationError = false) {
  const onAdd = vi.fn();
  const onRetry = vi.fn();
  render(<BlockPalette hasTrigger onAdd={onAdd} integrations={integrations} integrationError={integrationError} onRetry={onRetry} />);
  return { onAdd, onRetry };
}

function actionButton(type: string) {
  const block = CATALOG.find((item) => item.type === type)!;
  return screen.queryByRole('button', { name: `${block.name} ${block.description}` });
}

it('offers only provider actions with both configuration and connection, keeping internal actions', () => {
  const { onAdd } = palette([status('google'), status('slack', true, false), status('github', false, true)]);
  expect(actionButton('gmail_send_email')).not.toBeNull();
  expect(actionButton('calendar_create_event')).not.toBeNull();
  for (const type of ['slack_post_message', 'github_create_issue', 'outlook_send_email', 'notion_create_page']) {
    expect(actionButton(type)).toBeNull();
  }
  for (const type of ['send_email', 'call_webhook', 'discord_post_message']) expect(actionButton(type)).not.toBeNull();
  fireEvent.click(actionButton('send_email')!);
  expect(onAdd.mock.calls[0][0].type).toBe('send_email');
});

it('exposes every implemented provider action when all accounts are executable', () => {
  palette(['google', 'slack', 'github', 'notion', 'todoist', 'linear', 'microsoft', 'telegram', 'trello'].map(
    (provider) => status(provider as IntegrationStatus['provider']),
  ));
  for (const block of CATALOG.filter((item) => item.kind === 'action')) expect(actionButton(block.type)).not.toBeNull();
});

it('keeps only self-contained actions when no integration exists, with no dead connect link', () => {
  palette([]);
  expect(CATALOG.filter((item) => item.kind === 'action' && actionButton(item.type)).map((item) => item.type))
    .toEqual(['send_email', 'call_webhook', 'discord_post_message']);
  expect(screen.getByText(strings.flows.palette.noConnections)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

it('offers a connection link for a configured account that is not connected yet', () => {
  palette([status('google', true, false)]);
  expect(screen.getByRole('link').getAttribute('href')).toBe('/integrations');
  expect(actionButton('gmail_send_email')).toBeNull();
});

it('keeps internal actions usable during loading or an integration error and allows retry', () => {
  const { onRetry } = palette(null, true);
  expect(screen.getByRole('alert').textContent).toBe(strings.flows.palette.integrationsFailed);
  expect(actionButton('send_email')).not.toBeNull();
  expect(actionButton('gmail_send_email')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: strings.flows.palette.retry }));
  expect(onRetry).toHaveBeenCalledOnce();
});
