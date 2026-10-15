import { AppShell } from "@/components/core/app-shell";
import { WorkspaceProvider } from "@/components/enterprise/workspace-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceProvider><AppShell>{children}</AppShell></WorkspaceProvider>;
}
