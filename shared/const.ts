export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

// One-time nonce cookie that binds an OAuth login to the browser that started it. The
// `__Host-` prefix forces the cookie host-only (Secure, Path=/, no Domain), so another
// site cannot plant a matching value in a victim's browser. `state` now carries the bare
// nonce — the redirect URI is fixed server-side and no longer round-trips through it.
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";
