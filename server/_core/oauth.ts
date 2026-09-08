import { randomUUID } from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS, OAUTH_STATE_COOKIE } from "@shared/const";
import {
  SESSION_MAX_AGE_SECONDS,
  buildAuthorizeUrl,
  createSessionToken,
  exchangeCodeForProfile,
  isAllowedEmail,
  upsertGoogleUser,
} from "./auth";
import { getSessionCookieOptions } from "./cookies";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  /**
   * Starts a login. The nonce is planted as a one-time cookie and echoed through Google in
   * `state`; an attacker can forge `state` but cannot set this cookie in a victim's browser.
   */
  app.get("/api/oauth/start", (req: Request, res: Response) => {
    const nonce = randomUUID();
    res.cookie(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      path: "/",
      secure: true,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(buildAuthorizeUrl(nonce));
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    const error = getQueryParam(req, "error");

    if (error) {
      // Google's codes are opaque to a non-developer, and each has a different fix in a
      // different console. Naming the fix is the difference between a dead end and a
      // one-minute correction.
      const explanations: Record<string, string> = {
        access_denied:
          "로그인이 취소되었거나, 이 계정이 아직 허용되지 않았습니다. Google Cloud → OAuth 동의 화면 → 테스트 사용자에 이 이메일이 있는지 확인하세요.",
        admin_policy_enforced:
          "조직 정책이 이 앱의 접근을 막고 있습니다. 개인 Google 계정으로 시도해 보세요.",
        redirect_uri_mismatch:
          "리디렉션 주소가 Google에 등록된 값과 다릅니다. Google Cloud → 사용자 인증 정보의 주소가 이 앱의 /api/oauth/callback 과 정확히 같은지 확인하세요.",
        invalid_client:
          "GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET 이 올바르지 않습니다.",
      };
      res
        .status(400)
        .send(
          `로그인을 완료하지 못했습니다 (${error}).\n\n${explanations[error] ?? "Google이 요청을 거부했습니다."}`
        );
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const expectedNonce = parseCookieHeader(req.headers.cookie ?? "")[
      OAUTH_STATE_COOKIE
    ];
    if (!expectedNonce || state !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, {
      path: "/",
      secure: true,
      sameSite: "lax",
    });

    try {
      const profile = await exchangeCodeForProfile(code);

      // Google verifies its own addresses; an unverified one could be claimed by someone
      // else later, and this app keys a whole workspace on the account.
      if (profile.email_verified === false) {
        res.status(403).send("이메일이 확인되지 않은 Google 계정입니다.");
        return;
      }
      if (!isAllowedEmail(profile.email)) {
        res
          .status(403)
          .send(
            `이 앱에 접근이 허용된 계정이 아닙니다: ${profile.email}\n\nRailway의 ALLOWED_EMAILS 에 이 주소를 추가하거나, 허용된 계정으로 다시 로그인하세요.`
          );
        return;
      }

      const user = await upsertGoogleUser(profile);
      const sessionToken = await createSessionToken(user.openId);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req),
        maxAge: Math.min(SESSION_MAX_AGE_SECONDS * 1000, ONE_YEAR_MS),
      });
      res.redirect("/");
    } catch (caught) {
      console.error("[OAuth] callback failed", caught);
      // The cause is almost always configuration — a missing database, a rejected token
      // exchange — and a bare "something went wrong" sends the operator hunting through
      // logs for something the page could have told them.
      const detail =
        caught instanceof Error ? caught.message : "알 수 없는 오류";
      res
        .status(500)
        .send(
          `로그인 처리 중 오류가 발생했습니다.\n\n${detail}\n\n설정 상태는 /api/trpc/system.config?input=%7B%7D 에서 확인할 수 있습니다.`
        );
    }
  });
}
