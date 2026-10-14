import CompanyContextForm from '@/components/enterprise/company-context-form';
import CorporateDomainCard from '@/components/corporate-domain-card';
import { requireEnterpriseAccess } from '@/lib/enterprise/access';

export default async function CompanyPage() {
  const access = await requireEnterpriseAccess('readCompanyContext');
  return (
    <div>
      <header className="enterprise-heading">
        <h1 className="h1">Empresa</h1>
      </header>
      <div className="enterprise-stack" style={{ maxWidth: 760 }}>
        <CompanyContextForm canEdit={access.capabilities.manageCompanyContext} />
        {access.root && (
          <div className="enterprise-access">
            <CorporateDomainCard />
          </div>
        )}
      </div>
    </div>
  );
}
