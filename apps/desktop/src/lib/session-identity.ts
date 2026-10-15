export interface SessionIdentity {
  userId: string;
  tenantId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (!value || typeof value !== "object") return false;
  const owner = value as SessionIdentity;
  return typeof owner.userId === "string" && UUID.test(owner.userId)
    && typeof owner.tenantId === "string" && UUID.test(owner.tenantId);
}

export function sameSessionIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.userId.toLowerCase() === b.userId.toLowerCase()
    && a.tenantId.toLowerCase() === b.tenantId.toLowerCase();
}
