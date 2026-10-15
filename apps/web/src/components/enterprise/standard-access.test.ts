import { beforeEach, expect, it, vi } from 'vitest';
import type { GroupDto, PolicyDto } from '@/lib/api/client';

const api = vi.hoisted(() => ({
  groups: vi.fn(),
  policies: vi.fn(),
  templates: vi.fn(),
  members: vi.fn(),
  groupPolicies: vi.fn(),
  createGroup: vi.fn(),
  createPolicy: vi.fn(),
  attach: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({
  listGroups: api.groups,
  listPolicies: api.policies,
  listPolicyTemplates: api.templates,
  listGroupMembers: api.members,
  listGroupPolicies: api.groupPolicies,
  createGroup: api.createGroup,
  createPolicy: api.createPolicy,
  attachPolicyToGroup: api.attach,
}));
import { prepareStandardAccess } from './standard-access';

const templates = [
  {
    id: 'read-only-access',
    document: {
      version: 'v1',
      statements: [{ effect: 'Allow', action: ['meeting:read'], resource: ['tenant:demo:*'] }],
    },
  },
  {
    id: 'meeting-analyst',
    document: {
      version: 'v1',
      statements: [
        { effect: 'Allow', action: ['meeting:read', 'task:write'], resource: ['tenant:demo:*'] },
      ],
    },
  },
];
let groups: GroupDto[];
let policies: PolicyDto[];
let attachments: Map<string, string[]>;

beforeEach(() => {
  groups = [];
  policies = [];
  attachments = new Map();
  for (const mock of Object.values(api)) mock.mockReset();
  api.groups.mockImplementation(async () => groups);
  api.policies.mockImplementation(async () => policies);
  api.templates.mockResolvedValue(templates);
  api.members.mockResolvedValue([]);
  api.groupPolicies.mockImplementation(async (groupId) => attachments.get(groupId) ?? []);
  api.createGroup.mockImplementation(async (name, description) => {
    const group = { id: `group-${groups.length}`, name, description } as GroupDto;
    groups.push(group);
    return group;
  });
  api.createPolicy.mockImplementation(async (name, document, description) => {
    const policy = { id: `policy-${policies.length}`, name, document, description } as PolicyDto;
    policies.push(policy);
    return policy;
  });
  api.attach.mockImplementation(async (policyId, groupId) => {
    attachments.set(groupId, [...(attachments.get(groupId) ?? []), policyId]);
  });
});

it('creates groups with the tenant-bound template documents and attaches each policy', async () => {
  await prepareStandardAccess();
  expect(groups.map((group) => group.name)).toEqual(['Somente leitura', 'Analistas de reuniões']);
  expect(policies.map((policy) => policy.document)).toEqual(
    templates.map((template) => template.document),
  );
  expect(api.attach.mock.calls).toEqual([
    ['policy-0', 'group-0'],
    ['policy-1', 'group-1'],
  ]);
});

it('recovers an unknown create outcome without duplicating groups or policies', async () => {
  api.createPolicy.mockImplementationOnce(async (name, document, description) => {
    policies.push({ id: 'policy-0', name, document, description } as PolicyDto);
    throw new Error('Connection lost after the server saved the policy');
  });
  await expect(prepareStandardAccess()).rejects.toThrow('Connection lost');
  expect(groups).toHaveLength(1);
  expect(policies).toHaveLength(1);
  await prepareStandardAccess();
  expect(groups).toHaveLength(2);
  expect(policies).toHaveLength(2);
  expect(api.createGroup).toHaveBeenCalledTimes(2);
  expect(api.createPolicy).toHaveBeenCalledTimes(2);
  expect(api.attach.mock.calls).toEqual([
    ['policy-0', 'group-0'],
    ['policy-1', 'group-1'],
  ]);
});

it('reuses completed creates and retries an interrupted attachment', async () => {
  api.attach.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(prepareStandardAccess()).rejects.toThrow('Unavailable');
  await prepareStandardAccess();
  expect(api.createGroup).toHaveBeenCalledTimes(2);
  expect(api.createPolicy).toHaveBeenCalledTimes(2);
  expect(api.attach.mock.calls).toEqual([
    ['policy-0', 'group-0'],
    ['policy-0', 'group-0'],
    ['policy-1', 'group-1'],
  ]);
});

it('does not attach a customized policy with the same name', async () => {
  policies.push({
    id: 'custom',
    name: 'meeting-analyst',
    document: { statements: [{ action: ['iam:*'] }] },
  } as PolicyDto);
  await expect(prepareStandardAccess()).rejects.toThrow('foi personalizada');
  expect(api.createGroup).not.toHaveBeenCalled();
  expect(api.createPolicy).not.toHaveBeenCalled();
  expect(api.attach).not.toHaveBeenCalled();
});

it('does not change the permissions of an existing occupied group', async () => {
  groups.push({ id: 'existing', name: 'Somente leitura' } as GroupDto);
  api.members.mockResolvedValue(['existing-user']);
  await expect(prepareStandardAccess()).rejects.toThrow('já tem usuários');
  expect(api.createGroup).not.toHaveBeenCalled();
  expect(api.createPolicy).not.toHaveBeenCalled();
  expect(api.attach).not.toHaveBeenCalled();
});

it('leaves already configured groups unchanged after users have joined', async () => {
  await prepareStandardAccess();
  api.members.mockResolvedValue(['accepted-user']);
  api.createGroup.mockClear();
  api.createPolicy.mockClear();
  api.attach.mockClear();

  await prepareStandardAccess();

  expect(api.groupPolicies.mock.calls).toEqual([['group-0'], ['group-1']]);
  expect(api.createGroup).not.toHaveBeenCalled();
  expect(api.createPolicy).not.toHaveBeenCalled();
  expect(api.attach).not.toHaveBeenCalled();
});

it('does not add a standard policy to an occupied group with a different attachment', async () => {
  await prepareStandardAccess();
  attachments.set('group-0', ['other-policy']);
  api.members.mockResolvedValue(['accepted-user']);
  api.attach.mockClear();

  await expect(prepareStandardAccess()).rejects.toThrow('não possui o acesso padrão');
  expect(api.attach).not.toHaveBeenCalled();
});

it('recovers an unknown attachment outcome after an invite has been accepted', async () => {
  api.attach.mockImplementationOnce(async (policyId, groupId) => {
    attachments.set(groupId, [policyId]);
    throw new Error('Connection lost after the server attached the policy');
  });
  await expect(prepareStandardAccess()).rejects.toThrow('Connection lost');
  api.members.mockResolvedValue(['accepted-user']);

  await prepareStandardAccess();

  expect(api.createGroup).toHaveBeenCalledTimes(2);
  expect(api.createPolicy).toHaveBeenCalledTimes(2);
  expect(api.attach.mock.calls).toEqual([
    ['policy-0', 'group-0'],
    ['policy-1', 'group-1'],
  ]);
});

it('does not write anything when existing attachments cannot be verified', async () => {
  groups.push({ id: 'existing', name: 'Somente leitura' } as GroupDto);
  api.groupPolicies.mockRejectedValue(new Error('Unavailable'));

  await expect(prepareStandardAccess()).rejects.toThrow('Unavailable');
  expect(api.createGroup).not.toHaveBeenCalled();
  expect(api.createPolicy).not.toHaveBeenCalled();
  expect(api.attach).not.toHaveBeenCalled();
});
