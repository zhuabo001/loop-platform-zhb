/**
 * The Dashboard's HTTP surface (Batch 3 plan §2 切片二): TWO routes, mounted
 * ONLY when the server is bound to a loopback address.
 *
 *   GET  /                          → the SSR page (3s meta refresh, no JS)
 *   POST /dashboard/loops/:id/run   → Run Now, behind URL-encoded-form + CSRF
 *
 * Threat model — this is a LOCAL page, and the whole design assumes a hostile
 * web page may be talking to it:
 *  - DNS rebinding: after a rebind the browser still believes it is on the
 *    attacker's origin, so responses are READABLE. `hostGate` therefore
 *    rejects any request whose effective host is not loopback, and the caller
 *    registers it GLOBALLY (a dashboard-only gate would leave `/api/loops`
 *    readable and its ids usable for a blind trigger).
 *  - CSRF: a cross-origin form POST carries no token; the token is minted per
 *    bootstrap, never leaves this instance's memory, and is verified before
 *    the coordinator is called.
 *  - Response headers: no-store (the page holds a token), no-referrer (the URL
 *    carries loop ids), nosniff, and a CSP whose only allowance is the hash of
 *    the one inline stylesheet.
 *
 * Every response here is built through `securityHeaders()` — deliberately NOT
 * via Hono's prepared headers, which are dropped whenever a handler or
 * middleware returns a bare `new Response(...)` (verified on 4.12.32; that is
 * exactly the path `bodyLimit`'s onError takes).
 */
import { createHash } from "node:crypto";

import type { Context, Handler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { ArtifactReadFailure } from "../artifact/error-mapping.js";
import type { EnqueueExecRunResult } from "../store/runs.js";
import { isLoopbackHost } from "../config.js";
import { jsonError } from "../http/json-error.js";
import { checkCsrfForm, checkCsrfFormFields } from "./csrf.js";
import type { DashboardArtifactRead, DashboardRead } from "./index.js";
import {
  DASHBOARD_CSS,
  renderArtifactDiffPage,
  renderDashboardErrorPage,
  renderDashboardPage,
  renderLoopArtifactsPage,
  renderRunArtifactsPage,
} from "./page.js";
import {
  ARTIFACT_DIR_FIELD,
  buildArtifactDiffPageModel,
  buildDashboardPageModel,
  buildLoopArtifactsPageModel,
  buildRunArtifactsPageModel,
  dashboardArtifactsPath,
} from "./view.js";

/** The dashboard form body cap — a single token field needs ~50 bytes. */
export const DASHBOARD_FORM_CAP_BYTES = 4096;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** The CSP's only allowance: the SHA-256 of the one inline <style>, in
 *  standard base64 (NOT base64url), derived from the constant so the header
 *  and the stylesheet can never drift. */
export function dashboardStyleHash(css: string = DASHBOARD_CSS): string {
  return createHash("sha256").update(css).digest("base64");
}

export function dashboardCsp(css: string = DASHBOARD_CSS): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'sha256-${dashboardStyleHash(css)}'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The security headers EVERY dashboard response carries (see the module
 *  header for why they are applied explicitly rather than prepared). */
export function securityHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": dashboardCsp(),
  });
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function dashboardJson(status: 400 | 403 | 413 | 415 | 500, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: securityHeaders({ "content-type": "application/json" }),
  });
}

/**
 * The request's effective host must be loopback, from BOTH sources that can
 * carry one:
 *  - the `Host` header, when present — an unparseable or userinfo-bearing
 *    value is REJECTED, never treated as "absent" (that conflation would let
 *    `evil.com@127.0.0.1` through: `new URL()` reads its hostname as
 *    127.0.0.1);
 *  - the request URL's host (production node-server builds that URL from the
 *    Host header; Hono's app.request defaults to `http://localhost`).
 * They differ only for an absolute-form request line, which no browser sends —
 * checking both is hardening, and it keeps the gate provable in unit tests.
 */
function hostIsLoopback(c: Context): boolean {
  const rawHeader = c.req.header("host");
  if (rawHeader !== undefined) {
    const header = normalizeHost(rawHeader);
    if (header === null || !isLoopbackHost(header)) return false;
  }

  let url: string | null;
  try {
    url = normalizeHost(new URL(c.req.url).host);
  } catch {
    url = null;
  }
  return url !== null && isLoopbackHost(url);
}

/** `host[:port]` → the bare host, lowercased; `null` for anything malformed or
 *  carrying userinfo. Never throws: a throw here would surface as a 500 and
 *  that would itself be a signal. */
export function normalizeHost(authority: string): string | null {
  if (authority === "" || authority.includes("@")) return null;
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

export interface DashboardRouteDeps {
  /** The read seam — narrow on purpose (see dashboard/index.ts). */
  read: DashboardRead;
  /** The artifact read seam for the slice-7 pages (ADR-010 决策 27).
   *  OPTIONAL: absent ⇒ the caller registers no artifact page routes and the
   *  paths stay indistinguishable from any unknown route — the 11+ existing
   *  `createDashboardRoutes` call sites (no artifacts wiring) keep working
   *  unchanged. */
  artifacts?: DashboardArtifactRead;
  /** The manual trigger, narrowed to its call shape. The no-supersede policy
   *  (`{ kind: "manual", pendingPolicy: "skip" }`) is wired in `start.ts`, not
   *  here: this module holds no trigger semantics, so the seam stays one
   *  argument. That also means a dropped policy is invisible to the type
   *  checker — `mount.test.ts` pins the assembled behaviour instead. */
  enqueue: (loopId: string) => Promise<EnqueueExecRunResult>;
  /** Minted once per bootstrap; test-only injectable (see start.ts). */
  csrfToken: string;
}

export interface DashboardRoutes {
  /** Registered GLOBALLY by the caller, before any route: on a loopback-bound
   *  server every request — dashboard AND JSON API — must address a loopback
   *  host, or it is answered with the ordinary 404. Registering it late, or
   *  per-route, would leave a bypass. */
  hostGate: MiddlewareHandler;
  /** Rejects anything that is not an URL-encoded form (415). Sits before the
   *  body cap so the media type is judged before the body is read. */
  formContentType: MiddlewareHandler;
  bodyCap: MiddlewareHandler;
  index: Handler;
  run: Handler;
  /** The four slice-7 artifact page handlers — PRESENT ONLY when deps carried
   *  the artifact seam; the caller registers each one it received. */
  loopArtifacts?: Handler;
  runArtifacts?: Handler;
  artifactDiff?: Handler;
  artifactConfig?: Handler;
}

export function createDashboardRoutes(deps: DashboardRouteDeps): DashboardRoutes {
  const hostGate: MiddlewareHandler = async (c, next) => {
    if (!hostIsLoopback(c)) {
      // Deliberately the SAME response app.notFound produces, with no
      // dashboard headers: "not mounted", "hostile host" and "unknown path"
      // must be indistinguishable.
      return jsonError(c, 404, "not found");
    }
    return next();
  };

  const formContentType: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header("content-type");
    const mediaType = raw?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== FORM_CONTENT_TYPE) {
      return dashboardJson(415, "unsupported media type");
    }
    return next();
  };

  const bodyCap = bodyLimit({
    maxSize: DASHBOARD_FORM_CAP_BYTES,
    // Runs before the handler, so these headers must be built here — a bare
    // Response would otherwise be the one dashboard response without a CSP.
    onError: () => dashboardJson(413, "request body too large"),
  });

  const index: Handler = async () => {
    try {
      const model = buildDashboardPageModel(await deps.read.snapshot());
      return new Response(renderDashboardPage(model, { csrfToken: deps.csrfToken }), {
        status: 200,
        headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
      });
    } catch (err) {
      console.error("[dashboard] unhandled error", err);
      return dashboardJson(500, "internal server error");
    }
  };

  const run: Handler = async (c) => {
    try {
      const verdict = checkCsrfForm(await c.req.text(), deps.csrfToken);
      switch (verdict) {
        case "bad_form":
          return dashboardJson(400, "invalid request");
        case "token_missing":
        case "token_duplicate":
        case "token_mismatch":
          return dashboardJson(403, "forbidden");
        case "ok":
          break;
      }

      // Always present for this route pattern; the fallback folds the
      // impossible case into the ordinary "unknown loop" outcome.
      const loopId = c.req.param("id") ?? "";
      // The decision lives in the coordinator; every business outcome —
      // created, loop gone, completed, already running, already pending (the
      // skip policy this route is wired to) — is the same redirect, so the
      // page never reports a result it cannot verify. A throw is NOT swallowed
      // into a redirect: 500 must not be disguised as success.
      await deps.enqueue(loopId);
      return new Response(null, {
        status: 303,
        headers: securityHeaders({ location: "/" }),
      });
    } catch (err) {
      console.error("[dashboard] unhandled error", err);
      return dashboardJson(500, "internal server error");
    }
  };

  // ---- slice 7 artifact pages (ADR-010 决策 27) ----
  // Defined ONLY when the artifact seam was injected; the caller registers
  // exactly what it received, so "no artifacts" keeps every artifact path the
  // indistinguishable 404 it always was.
  const artifacts = deps.artifacts;

  /** The fixed-string page failure (404/403); storage errors stay JSON 500s.
   *  Existence never leaks: unknown/cross-scope are one 404 text. */
  function artifactPageFailure(c: Context, failure: ArtifactReadFailure): Response {
    switch (failure) {
      case "loop_not_found":
      case "run_not_found":
      case "snapshot_not_found":
      case "path_not_found":
        return new Response(renderDashboardErrorPage("Artifact", "请求的资源不存在或不可见。"), {
          status: 404,
          headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
        });
      case "attribution_missing":
        return new Response(renderDashboardErrorPage("Artifact", "归属缺失，无法读取 Artifact 视图。"), {
          status: 403,
          headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
        });
      case "storage_error":
        return dashboardJson(500, "internal server error");
      default:
        return dashboardJson(500, "internal server error");
    }
  }

  const loopArtifacts: Handler | undefined =
    artifacts &&
    (async (c) => {
      try {
        const loopId = c.req.param("id") ?? "";
        // 决策 27's evaluation order holds for the page too (review #113):
        // the domain verdict comes FIRST, the bare snapshot-list read only
        // after it — a list-read fault must never mask attribution_missing
        // (403) into a 500. Sequential, not Promise.all.
        const view = await artifacts.loopArtifacts(loopId);
        if (!view.ok) return artifactPageFailure(c, view.failure);
        const bound = await artifacts.boundSnapshots(loopId);
        const model = buildLoopArtifactsPageModel({
          loopId,
          view: view.response,
          bound,
          configToken: c.req.query("config") ?? null,
        });
        return new Response(renderLoopArtifactsPage(model, { csrfToken: deps.csrfToken }), {
          status: 200,
          headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
        });
      } catch (err) {
        console.error("[dashboard] artifact page error", err);
        return dashboardJson(500, "internal server error");
      }
    });

  const runArtifacts: Handler | undefined =
    artifacts &&
    (async (c) => {
      try {
        const result = await artifacts.runArtifacts(c.req.param("runId") ?? "");
        if (!result.ok) return artifactPageFailure(c, result.failure);
        // #111: the run page is NESTED under its parent loop — the run is
        // visible only from the loop it belongs to. A mismatched parent path
        // is one 404, indistinguishable from "never existed" (决策 13:
        // existence never leaks across scopes, and another loop's file table
        // must never render under the wrong parent).
        if (result.response.loopId !== (c.req.param("id") ?? "")) {
          return artifactPageFailure(c, "run_not_found");
        }
        return new Response(renderRunArtifactsPage(buildRunArtifactsPageModel({ response: result.response })), {
          status: 200,
          headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
        });
      } catch (err) {
        console.error("[dashboard] run artifact page error", err);
        return dashboardJson(500, "internal server error");
      }
    });

  const artifactDiff: Handler | undefined =
    artifacts &&
    (async (c) => {
      try {
        const loopId = c.req.param("id") ?? "";
        // Same normalization as the JSON route: an empty baseline option
        // submits `from=`.
        const rawFrom = c.req.query("from");
        const from = rawFrom === undefined || rawFrom === "" ? undefined : rawFrom;
        const to = c.req.query("to");
        if (to === undefined || to === "") {
          // No target chosen yet: back to the artifact page, where the diff
          // form's defaults are pre-selected.
          return new Response(null, {
            status: 303,
            headers: securityHeaders({ location: dashboardArtifactsPath(loopId) }),
          });
        }
        // Same domain-first sequencing as the artifacts page (#113): the
        // diff verdict precedes the bare snapshot-list read.
        const result = await artifacts.diff(loopId, { from, to });
        if (!result.ok) return artifactPageFailure(c, result.failure);
        const bound = await artifacts.boundSnapshots(loopId);
        const model = buildArtifactDiffPageModel({
          loopId,
          response: result.response,
          bound,
          selectedFrom: from ?? "",
          selectedTo: to,
        });
        return new Response(renderArtifactDiffPage(model), {
          status: 200,
          headers: securityHeaders({ "content-type": "text/html; charset=UTF-8" }),
        });
      } catch (err) {
        console.error("[dashboard] diff page error", err);
        return dashboardJson(500, "internal server error");
      }
    });

  const artifactConfig: Handler | undefined =
    artifacts &&
    (async (c) => {
      try {
        const verdict = checkCsrfFormFields(await c.req.text(), deps.csrfToken, [ARTIFACT_DIR_FIELD]);
        if (!verdict.ok) {
          switch (verdict.verdict) {
            case "bad_form":
            case "field_duplicate":
              return dashboardJson(400, "invalid request");
            case "token_missing":
            case "token_duplicate":
            case "token_mismatch":
              return dashboardJson(403, "forbidden");
          }
        }
        const loopId = c.req.param("id") ?? "";
        // Empty input clears the config — the form's hint states exactly this.
        const rawDir = verdict.values.get(ARTIFACT_DIR_FIELD) ?? "";
        const result = await artifacts.updateConfig(loopId, {
          artifactDir: rawDir.trim() === "" ? null : rawDir,
        });
        let token: string;
        if (!result.ok) {
          token =
            result.failure === "loop_not_found"
              ? "not_found"
              : result.failure === "artifact_dir_invalid" || result.failure === "artifact_dir_relative_without_workdir"
                ? "artifact_validation_failed"
                : "artifact_config_conflict";
        } else {
          token = result.outcome === "noop" ? "unchanged" : result.loop.artifactDir === null ? "cleared" : "updated";
        }
        // The run-form precedent: every business outcome is one 303; the
        // banner token rides the location (fixed set, inert when unknown).
        return new Response(null, {
          status: 303,
          headers: securityHeaders({ location: `${dashboardArtifactsPath(loopId)}?config=${token}` }),
        });
      } catch (err) {
        console.error("[dashboard] artifact config error", err);
        return dashboardJson(500, "internal server error");
      }
    });

  return { hostGate, formContentType, bodyCap, index, run, loopArtifacts, runArtifacts, artifactDiff, artifactConfig };
}

/** Re-exported so the composition root has ONE dashboard import for both the
 *  routes object and the path it must register. The constants themselves are
 *  defined in view.ts, next to the link builders they have to agree with. */
export {
  DASHBOARD_ARTIFACT_CONFIG_PATH,
  DASHBOARD_ARTIFACT_DIFF_PATH,
  DASHBOARD_LOOP_ARTIFACTS_PATH,
  DASHBOARD_RUN_ARTIFACTS_PATH,
  DASHBOARD_RUN_PATH,
} from "./view.js";
