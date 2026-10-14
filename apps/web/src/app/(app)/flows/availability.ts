import type { IntegrationProvider, IntegrationStatus } from '@/lib/api/types';

const ACTION_PROVIDER: Partial<Record<string, IntegrationProvider>> = {
  gmail_send_email: 'google',
  calendar_create_event: 'google',
  github_create_issue: 'github',
  notion_create_page: 'notion',
  todoist_create_task: 'todoist',
  linear_create_issue: 'linear',
  slack_post_message: 'slack',
  outlook_send_email: 'microsoft',
  mscalendar_create_event: 'microsoft',
  telegram_send_message: 'telegram',
  trello_create_card: 'trello',
};

export function isActionAvailable(type: string, integrations: IntegrationStatus[] | null): boolean {
  const provider = ACTION_PROVIDER[type];
  return !provider || Boolean(integrations?.some(
    (integration) => integration.provider === provider && integration.configured && integration.connected,
  ));
}
