// Pure, environment-agnostic JWT helpers.
//
// Intentionally unverified — the server is the source of truth for token
// validity. These functions read client-visible payload fields only and
// must not be relied on for authorization decisions.

import { JwtPayload } from 'jwt-decode';

// Mirrors the server-side `gjwt.WebSessionTokenClaims` shape:
//   userID    -> user_id
//   sessionID -> s_id
//   handle    -> handle
//   expiresAt -> exp (standard JWT claim, unix seconds)
//   scopes    -> scopes
export interface SessionJwtClaims extends JwtPayload {
    user_id: string;
    s_id: string;
    handle: string;
    exp: number;
    scopes: string[];
}
