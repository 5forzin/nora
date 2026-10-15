'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import type { MeResponse } from '@/lib/api/client';

export function EnterpriseNavigation({ access }: { access: MeResponse }) {
  const pathname = usePathname();
  const entries = [
    {
      href: '/enterprise',
      label: 'Visão executiva',
      visible: access.capabilities.viewExecutiveOverview,
    },
    { href: '/enterprise/users', label: 'Usuários', visible: access.capabilities.manageUsers },
    { href: '/enterprise/access', label: 'Acessos', visible: access.capabilities.manageAccess },
    {
      href: '/enterprise/company',
      label: 'Empresa',
      visible: access.capabilities.readCompanyContext,
    },
  ];

  return (
    <nav className="enterprise-nav" aria-label="Enterprise">
      {entries
        .filter((entry) => entry.visible)
        .map((entry) => (
          <Link
            key={entry.href}
            href={entry.href as Route}
            aria-current={pathname === entry.href ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        ))}
    </nav>
  );
}
