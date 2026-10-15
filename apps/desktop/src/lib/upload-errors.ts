export function uploadErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const match = message.match(/\((\d{3})(?:\s[^)]*)?\)/);
  return match ? Number(match[1]) : undefined;
}

export function isSessionUploadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = uploadErrorStatus(error);
  return /ACCOUNT_MISMATCH|SESSION_UNAVAILABLE|Session not found/.test(message)
    || status === 401 || status === 403;
}

export function isPermanentUploadError(error: unknown): boolean {
  const status = uploadErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500
    && status !== 401 && status !== 403 && status !== 429;
}
