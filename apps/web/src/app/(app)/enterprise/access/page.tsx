import AccessManager from '@/components/enterprise/access-manager';
import { requireEnterpriseAccess } from '@/lib/enterprise/access';

export default async function AccessPage() {
  await requireEnterpriseAccess('manageAccess');
  return <AccessManager />;
}
