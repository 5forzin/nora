import {
  attachPolicyToGroup,
  createGroup,
  createPolicy,
  listGroupMembers,
  listGroupPolicies,
  listGroups,
  listPolicies,
  listPolicyTemplates,
} from '@/lib/api/client';

const PRESETS = [
  {
    template: 'read-only-access',
    group: 'Somente leitura',
    description: 'Consulta reuniões, tarefas e contexto da empresa.',
  },
  {
    template: 'meeting-analyst',
    group: 'Analistas de reuniões',
    description: 'Importa, atualiza e remove reuniões; edita tarefas.',
  },
] as const;

export class StandardAccessError extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export async function prepareStandardAccess(): Promise<void> {
  const [groups, policies, templates] = await Promise.all([
    listGroups(),
    listPolicies(),
    listPolicyTemplates(),
  ]);
  const plans = PRESETS.map((preset) => {
    const template = templates.find((item) => item.id === preset.template);
    if (!template)
      throw new StandardAccessError(`O modelo de acesso “${preset.group}” está indisponível.`);
    const group = groups.find((item) => item.name === preset.group);
    const policy = policies.find((item) => item.name === preset.template);
    if (
      policy &&
      JSON.stringify(canonical(policy.document)) !== JSON.stringify(canonical(template.document))
    ) {
      throw new StandardAccessError(
        `A policy “${preset.template}” foi personalizada. Revise-a em Acessos.`,
      );
    }
    return { preset, template, group, policy };
  });

  const checkedPlans = await Promise.all(
    plans.map(async (plan) => {
      const { preset, group, policy } = plan;
      if (!group) return { ...plan, configured: false };
      const attachedPolicies = await listGroupPolicies(group.id);
      if (policy && attachedPolicies.includes(policy.id)) return { ...plan, configured: true };
      // A missing attachment may be added only while the group has no members.
      if ((await listGroupMembers(group.id)).length > 0) {
        throw new StandardAccessError(
          `O grupo “${preset.group}” já tem usuários e não possui o acesso padrão. Revise os vínculos em Acessos.`,
        );
      }
      return { ...plan, configured: false };
    }),
  );

  for (const {
    preset,
    template,
    group: existingGroup,
    policy: existingPolicy,
    configured,
  } of checkedPlans) {
    if (configured) continue;
    const group = existingGroup ?? (await createGroup(preset.group, preset.description));
    const policy =
      existingPolicy ??
      (await createPolicy(preset.template, template.document, preset.description));
    // The API makes this attachment idempotent; a retry reuses any completed creates.
    await attachPolicyToGroup(policy.id, group.id);
  }
}
