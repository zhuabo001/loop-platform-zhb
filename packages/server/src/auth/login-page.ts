/**
 * The `/login` SSR page (Batch 3 slice 2): the GitHub login entry. Rendered
 * with `hono/html` (every interpolation auto-escapes; `raw()` is never
 * called), zero client-side JavaScript, zero inline style — so it satisfies
 * the shared `securityHeaders()` CSP untouched.
 *
 * The `?error=` query carries one of the FROZEN OAuth classifications
 * (errors.ts) and is mapped to a fixed message; an unknown value falls back
 * to the generic message — the raw parameter is NEVER echoed into the page.
 */
import { html } from "hono/html";

import { OAUTH_FAILURES, type OAuthFailure } from "./errors.js";

/** Fixed user-facing message per frozen classification (Chinese, matching the
 *  dashboard's language). */
const ERROR_MESSAGES: Record<OAuthFailure, string> = {
  access_denied: "你拒绝了 GitHub 授权，登录未完成。",
  state_missing: "登录状态缺失，请重新登录。",
  state_unknown: "登录会话已过期或已被使用，请重新登录。",
  state_mismatch: "登录状态校验失败，请重新登录。",
  code_missing: "GitHub 回调缺少授权码，请重新登录。",
  exchange_failed: "GitHub 授权交换失败，请稍后重试。",
  network_error: "暂时无法连接 GitHub，请稍后重试。",
  response_invalid: "GitHub 返回了无法识别的响应，请稍后重试。",
};

const GENERIC_ERROR_MESSAGE = "登录未完成，请重新登录。";

/** Map the raw `?error=` param to a fixed message; null when absent. The raw
 *  value is never returned — only frozen strings leave this function. */
export function loginErrorMessage(errorParam: string | undefined): string | null {
  if (errorParam === undefined) return null;
  return (OAUTH_FAILURES as readonly string[]).includes(errorParam)
    ? ERROR_MESSAGES[errorParam as OAuthFailure]
    : GENERIC_ERROR_MESSAGE;
}

export function renderLoginPage(opts: { error?: string } = {}): string {
  const message = loginErrorMessage(opts.error);
  return String(html`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>登录 — loopzhb</title>
  </head>
  <body>
    <main>
      <h1>登录 loopzhb</h1>
      ${message === null ? null : html`<p role="alert">${message}</p>`}
      <p><a href="/auth/github">使用 GitHub 登录</a></p>
    </main>
  </body>
</html>`);
}
