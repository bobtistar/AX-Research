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
      res.status(400).send(`로그인이 취소되었습니다: ${error}`);
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
            "이 앱에 접근이 허용된 계정이 아닙니다. 관리자에게 문의하세요."
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
      res.status(500).send("로그인 처리 중 오류가 발생했습니다.");
    }
  });
}
