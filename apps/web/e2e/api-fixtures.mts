import type { MeResponse, TenantInfo, TrendsResponse, UsageResponse } from '../src/lib/api/types.ts';

export const SESSION_COOKIE = 'nora_access';
export const FIXTURE_TOKEN = 'e2e-fixture-not-a-real-token';

export const workspace: MeResponse = {
  userId: 'e2e-root',
  tenantId: 'e2e-workspace',
  email: 'root@example.test',
  displayName: 'E2E Root',
  emailVerified: true,
  createdAt: '2026-10-01T12:00:00Z',
  tenantName: 'E2E workspace',
  plan: 'ENTERPRISE',
  root: true,
  capabilities: {
    manageUsers: true,
    manageAccess: true,
    readCompanyContext: true,
    manageCompanyContext: true,
    viewExecutiveOverview: true,
  },
  permissions: {
    readMeetings: true,
    createMeetings: true,
    captureMeetings: true,
    updateMeetings: true,
    reprocessMeetings: true,
    deleteMeetings: true,
    eraseMeetings: true,
    readTasks: true,
    writeTasks: true,
    readFlows: true,
    manageFlows: true,
    testFlows: true,
    readIntegrations: true,
    manageIntegrations: true,
    readWorkspace: true,
    renameWorkspace: true,
  },
};

const tenant: TenantInfo = {
  id: workspace.tenantId,
  name: workspace.tenantName,
  slug: 'e2e-workspace',
  plan: workspace.plan,
  createdAt: workspace.createdAt,
};

const trends: TrendsResponse = {
  granularity: 'WEEK',
  timezone: 'UTC',
  from: '2026-10-01T00:00:00Z',
  to: '2026-11-01T00:00:00Z',
  scopeStrategy: 'TENANT_UNIFORM',
  dataState: 'NO_MEETINGS',
  meetings: 0,
  analysedMeetings: 0,
  taskLoad: { buckets: [], open: 0, overdue: 0, byPriority: { HIGH: 0, MEDIUM: 0, LOW: 0 }, hasData: false },
  themes: { source: 'ANALYSIS_TOPICS', matching: 'LEXICAL', minimumMeetings: 3, sufficient: false, overall: [], buckets: [] },
};

const usage: UsageResponse = {
  granularity: trends.granularity,
  timezone: trends.timezone,
  from: trends.from,
  to: trends.to,
  scopeStrategy: trends.scopeStrategy,
  dataState: 'NO_DATA',
  meetings: 0,
  analysedMeetings: 0,
  meetingBuckets: [],
  ai: { state: 'UNAVAILABLE', costBasis: 'CATALOG_LIST_PRICE', currency: 'USD', calls: 0, unmeteredCalls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, byService: [], buckets: [] },
};

export const responses: Record<string, unknown> = {
  '/auth/me': workspace,
  '/tenant': tenant,
  '/tasks': { items: [], page: 0, size: 100, totalItems: 0, totalPages: 0 },
  '/meetings/participants': { items: [] },
  '/trends': trends,
  '/usage': usage,
  '/chat/sessions': [],
  '/workflows': [],
  '/integrations': [],
  '/iam/groups': [],
  '/iam/policies': [],
  '/iam/policy-templates': [],
  '/iam/audit': [],
  '/iam/users': [{ id: workspace.userId, email: workspace.email, displayName: workspace.displayName, root: true }],
  '/iam/invites': { items: [], total: 0, page: 0, size: 20 },
};
