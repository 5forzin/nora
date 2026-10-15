export function providerOptions(provider: string, model: string): Record<string, string> {
  if (provider.trim().toLowerCase() !== 'google') return {};
  return { reasoning_effort: model.startsWith('gemini-2.5-') ? 'none' : 'low' };
}

export function providerEndpointAllowed(provider: string, baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const google = url.hostname.replace(/\.+$/, '') === 'generativelanguage.googleapis.com';
    if (provider.trim().toLowerCase() !== 'google') return !google;
    return (
      url.protocol === 'https:' &&
      url.host === 'generativelanguage.googleapis.com' &&
      url.pathname.replace(/\/$/, '') === '/v1beta/openai' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
