import { EnterpriseUsers } from '@/components/enterprise/enterprise-users';
import { requireEnterpriseAccess } from '@/lib/enterprise/access';

export default async function UsersPage() {
  const access = await requireEnterpriseAccess('manageUsers');
  return <EnterpriseUsers canManageAccess={access.capabilities.manageAccess} />;
}
