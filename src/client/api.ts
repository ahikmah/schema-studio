export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

const request = async <T>(method: string, path: string, value?: unknown): Promise<T> => {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: value === undefined ? undefined : { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, typeof payload.error === 'string' ? payload.error : 'Request failed', payload);
  return payload as T;
};

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, value?: unknown) => request<T>('POST', path, value),
  patch: <T>(path: string, value: unknown) => request<T>('PATCH', path, value),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
