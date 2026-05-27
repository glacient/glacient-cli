// Bearer-token refresh against the auth service.
//
// Used by non-browser callers (CLIs, server-to-server) that hold a refresh
// token directly rather than receiving it via cookie. Browser callers should
// continue to use `token-refresh-job.ts`, which sends the refresh token via
// `credentials: 'include'`.

export type RefreshTokens = {
    access_token: string;
    refresh_token: string;
};

export async function refreshSessionTokens(
    serverUrl: string,
    refreshToken: string,
): Promise<RefreshTokens> {
    const res = await globalThis.fetch(`${serverUrl}/auth/token-refresh`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${refreshToken}`,
            Accept: 'application/json',
        },
    });

    if (!res.ok) {
        throw new Error(`token refresh failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as RefreshTokens;
}
