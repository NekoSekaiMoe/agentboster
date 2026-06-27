export function createHttp(baseUrl: string, token?: string) {
  const root = baseUrl.replace(/\/$/, '');

  return async function http(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return fetch(`${root}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };
}
