export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Starts a Google login.
 *
 * The whole flow lives on the server: `/api/oauth/start` mints the CSRF nonce, sets it as
 * a one-time cookie, and redirects to Google. The browser never handles the nonce, so the
 * cookie and the `state` it echoes cannot drift apart — the failure mode the previous
 * client-side version had to warn about at length.
 */
export const startLogin = () => {
  window.location.href = "/api/oauth/start";
};
