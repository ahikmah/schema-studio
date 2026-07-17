import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/client/api';

describe('client API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves API status and message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Project changed"}', {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(api.patch('/api/projects/p1', {})).rejects.toEqual(expect.objectContaining({
      status: 409,
      message: 'Project changed',
    } satisfies Partial<ApiError>));
  });

  it('returns undefined for a successful empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(api.delete('/api/auth/logout')).resolves.toBeUndefined();
  });
});
