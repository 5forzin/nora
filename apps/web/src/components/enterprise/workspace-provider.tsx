'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, type MeResponse } from '@/lib/api/client';
import { SESSION_USER_EVENT } from '@/lib/auth';

type WorkspaceState = { access: MeResponse | null; loading: boolean };
const WorkspaceContext = createContext<WorkspaceState>({ access: null, loading: true });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>({ access: null, loading: true });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const access = await getMe();
        if (active) setState({ access, loading: false });
      } catch {
        if (active) setState({ access: null, loading: false });
      }
    }
    void load();
    window.addEventListener(SESSION_USER_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(SESSION_USER_EVENT, load);
    };
  }, []);

  return <WorkspaceContext.Provider value={state}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceAccess() {
  return useContext(WorkspaceContext);
}
