import { EnterpriseNavigation } from '@/components/enterprise/enterprise-navigation';
import { requireEnterpriseAccess } from '@/lib/enterprise/access';
import './enterprise.css';

export const dynamic = 'force-dynamic';

export default async function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  const access = await requireEnterpriseAccess();
  return (
    <div className="page enterprise-page">
      <header className="enterprise-workspace">
        <span className="plan-badge">Enterprise</span>
        <span>{access.tenantName}</span>
      </header>
      <EnterpriseNavigation access={access} />
      {children}
    </div>
  );
}
