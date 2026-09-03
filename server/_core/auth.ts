/**
 * Google sign-in and the session cookie.
 *
 * Replaces the Manus SDK. The flow is the standard OAuth authorisation-code exchange:
 * we send the browser to Google, Google sends it back with a one-time code, we trade the
 * code for the user's email and name, and then we mint our own session cookie. Google is
 * never consulted again — the cookie is the session.
 */
import { SignJWT, jwtVerify } from "jose";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { COOKIE_NAME } from "@shared/const";
import type { User } from "../../drizzle/schema";
import { getUserByOpenId, upsertUser } from "../db";
import { ENV } from "./env";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Email and profile only. Asking for more would drag the app into Google's review. */
const SCOPES = ["openid", "email", "profile"].join(" ");

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secretKey() {
  if (!ENV.cookieSecret)
    throw new Error("JWT_SECRET이 설정되지 않아 세션을 만들 수 없습니다.");
  return new TextEncoder().encode(ENV.cookieSecret);
}

export function redirectUri() {
  if (!ENV.appUrl)
    throw new Error("APP_URL이 설정되지 않아 로그인 주소를 만들 수 없습니다.");
  return `${ENV.appUrl}/api/oauth/callback`;
}

/** Where the browser goes to start a login. `state` carries the CSRF nonce. */
export function buildAuthorizeUrl(nonce: string) {
  const params = new URLSearchParams({
    client_id: ENV.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    state: nonce,
    // Always show the account chooser; otherwise a shared browser silently reuses one.
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

type GoogleProfile = {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
};

/** Trades the one-time code for the signed-in user's Google profile. */
export async function exchangeCodeForProfile(
  code: string
): Promise<GoogleProfile> {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: ENV.googleClientId,
      client_secret: ENV.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    throw new Error(
      `Google 토큰 교환 실패 (${tokenResponse.status}): ${detail}`
    );
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as {
    access_token?: string;
  };
  if (!accessToken) throw new Error("Google이 access token을 주지 않았습니다.");

  const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok)
    throw new Error(`Google 프로필 조회 실패 (${profileResponse.status})`);
  const profile = (await profileResponse.json()) as GoogleProfile;
  if (!profile.sub || !profile.email)
    throw new Error("Google 프로필에 계정 식별자나 이메일이 없습니다.");
  return profile;
}

/**
 * Whether this Google account may sign in. With ALLOWED_EMAILS unset the app is open to
 * anyone; it is set while the deployment holds only the owner's own research notes.
 */
export function isAllowedEmail(email: string) {
  if (ENV.allowedEmails.length === 0) return true;
  return ENV.allowedEmails.includes(email.trim().toLowerCase());
}

export async function createSessionToken(openId: string) {
  return new SignJWT({ openId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

async function verifySessionToken(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.openId === "string" ? payload.openId : null;
  } catch {
    // Expired, tampered with, or signed by an old JWT_SECRET.
    return null;
  }
}

/** Records the signed-in Google account, then returns the stored user row. */
export async function upsertGoogleUser(profile: GoogleProfile): Promise<User> {
  const openId = `google:${profile.sub}`;
  await upsertUser({
    openId,
    name: profile.name ?? profile.email,
    email: profile.email,
    loginMethod: "google",
    lastSignedIn: new Date(),
  });
  const user = await getUserByOpenId(openId);
  if (!user) throw new Error("로그인한 사용자를 저장하지 못했습니다.");
  return user;
}

/** Resolves the signed-in user for a request, or null for an anonymous one. */
export async function authenticateRequest(req: Request): Promise<User | null> {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const openId = await verifySessionToken(cookies[COOKIE_NAME]);
  if (!openId) return null;
  return (await getUserByOpenId(openId)) ?? null;
}
