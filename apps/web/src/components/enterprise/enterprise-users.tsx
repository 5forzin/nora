'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useState } from 'react';
import {
  listGroups,
  listGroupMembers,
  listIamUsers,
  type DirectoryUserDto,
} from '@/lib/api/client';
import { Avatar } from '@/components/core/avatar';
import InvitationCard from '@/components/invitation-card';
import { prepareStandardAccess, StandardAccessError } from './standard-access';

export function EnterpriseUsers({ canManageAccess }: { canManageAccess: boolean }) {
  const [users, setUsers] = useState<DirectoryUserDto[]>([]);
  const [groupsByUser, setGroupsByUser] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupsUnavailable, setGroupsUnavailable] = useState(false);
  const [query, setQuery] = useState('');
  const [preparingAccess, setPreparingAccess] = useState(false);
  const [accessPrepared, setAccessPrepared] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [groupsRevision, setGroupsRevision] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setGroupsUnavailable(false);
    const [directory, memberships] = await Promise.allSettled([
      listIamUsers(),
      listGroups().then((groups) =>
        Promise.all(
          groups.map(async (group) => ({
            name: group.name,
            members: await listGroupMembers(group.id),
          })),
        ),
      ),
    ]);
    if (directory.status === 'fulfilled') setUsers(directory.value);
    else setError('Não foi possível carregar os usuários.');
    if (memberships.status === 'fulfilled') {
      const names: Record<string, string[]> = {};
      for (const group of memberships.value) {
        for (const id of group.members) (names[id] ??= []).push(group.name);
      }
      setGroupsByUser(names);
    } else {
      setGroupsByUser({});
      setGroupsUnavailable(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function prepareAccess() {
    setPreparingAccess(true);
    setAccessError(null);
    try {
      await prepareStandardAccess();
      setAccessPrepared(true);
      setGroupsRevision((value) => value + 1);
      await load();
    } catch (failure) {
      setAccessError(
        failure instanceof StandardAccessError
          ? failure.message
          : 'Preparação interrompida. Tente novamente para concluir os acessos.',
      );
    } finally {
      setPreparingAccess(false);
    }
  }
  const normalized = query.trim().toLocaleLowerCase('pt-BR');
  const visibleUsers = users.filter((user) =>
    `${user.displayName} ${user.email}`.toLocaleLowerCase('pt-BR').includes(normalized),
  );

  return (
    <div className="enterprise-stack">
      <header className="enterprise-heading" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="h1">Usuários</h1>
          <p className="lede">Pessoas com acesso ao workspace.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          Atualizar
        </button>
      </header>

      <div className="field enterprise-search">
        <label className="field-label" htmlFor="enterprise-user-search">
          Buscar usuários
        </label>
        <input
          id="enterprise-user-search"
          className="input"
          placeholder="Nome ou e-mail"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="notice notice--danger">
          {error}{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
            Tentar novamente
          </button>
        </p>
      )}
      {loading ? (
        <p role="status" className="lede">
          Carregando usuários…
        </p>
      ) : (
        !error && (
          <div className="card enterprise-table-scroll" style={{ padding: 0 }}>
            <table className="enterprise-directory">
              <thead>
                <tr>
                  <th scope="col">Usuário</th>
                  <th scope="col">Acesso</th>
                  <th scope="col">Grupos</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="enterprise-directory-user">
                        <Avatar seed={user.email} size={32} />
                        <div>
                          {user.displayName}
                          <small>{user.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="chip">{user.root ? 'Root' : 'Membro'}</span>
                    </td>
                    <td className="enterprise-directory-groups">
                      {!user.root && <span className="enterprise-directory-group-label">Grupos: </span>}
                      {user.root
                        ? 'Acesso completo'
                        : groupsUnavailable
                          ? 'Indisponível'
                          : (groupsByUser[user.id]?.join(', ') ?? 'Sem grupo')}
                    </td>
                  </tr>
                ))}
                {visibleUsers.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ color: 'var(--muted)' }}>
                      {query ? 'Nenhum usuário encontrado.' : 'Nenhum usuário disponível.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}
      {groupsUnavailable && (
        <p className="lede">
          Não foi possível consultar os grupos. O diretório continua disponível.
        </p>
      )}
      {users.length >= 500 && <p className="lede">Exibindo os primeiros 500 usuários.</p>}
      {canManageAccess && (
        <section
          className="card enterprise-standard-access"
          aria-labelledby="standard-access-title"
        >
          <div className="enterprise-heading" style={{ marginBottom: 0 }}>
            <div>
              <h2 id="standard-access-title" className="h2">
                Acessos padrão
              </h2>
              <p className="lede">
                Somente leitura ou análise de reuniões, para escolher ao convidar.
              </p>
            </div>
            {!accessPrepared && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={preparingAccess}
                onClick={() => void prepareAccess()}
              >
                {preparingAccess ? 'Preparando…' : 'Preparar acessos'}
              </button>
            )}
          </div>
          {accessError && (
            <p role="alert" className="notice notice--danger">
              {accessError}
            </p>
          )}
          {accessPrepared && (
            <p role="status" className="lede">
              Acessos preparados. Escolha um grupo ao convidar.
            </p>
          )}
          <Link className="btn btn-ghost btn-sm" href={'/enterprise/access' as Route}>
            Gerenciar grupos e permissões
          </Link>
        </section>
      )}
      <div className="enterprise-access">
        <InvitationCard requireGroup groupsRevision={groupsRevision} />
      </div>
    </div>
  );
}
