"use client";

import Link from 'next/link';
import { useWorkspaceAccess } from '@/components/enterprise/workspace-provider';

type AccountSection = 'conta' | 'seguranca' | 'workspace';

export function SettingsNavigation({ section, onSectionChange }: {
  section: AccountSection | 'consumo';
  onSectionChange?: (section: AccountSection) => void;
}) {
  const { access } = useWorkspaceAccess();
  const sections: { id: AccountSection; label: string }[] = [
    { id: 'conta', label: 'Conta' },
    { id: 'seguranca', label: 'Segurança' },
    ...(access?.permissions?.readWorkspace ? [{ id: 'workspace' as const, label: 'Workspace' }] : []),
  ];
  return (
    <nav className="set-nav" aria-label="Seções de configurações">
      {sections.map((item) => (
        <Link key={item.id} href={`/settings/context#${item.id}`} className={section === item.id ? 'is-active' : undefined} aria-current={section === item.id ? 'page' : undefined}
          onClick={onSectionChange ? (event) => { event.preventDefault(); onSectionChange(item.id); } : undefined}>
          {item.label}
        </Link>
      ))}
      {access?.permissions?.readMeetings && <Link href="/settings/usage" className={section === 'consumo' ? 'is-active' : undefined} aria-current={section === 'consumo' ? 'page' : undefined}>Consumo</Link>}
    </nav>
  );
}
