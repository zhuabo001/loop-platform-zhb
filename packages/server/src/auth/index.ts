/**
 * The auth module's ONE composition entry (Batch 3 slice 2): builds the
 * pending-transaction store, the GitHub adapter, the identity and session
 * services and the routes from narrow injected deps. `bootstrapServer` calls
 * this with the real config/db/clock; tests inject a scripted `fetchImpl`
 * (never a real socket) and a FakeClock.
 */
import type { AuthConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Clock } from "../time.js";
import { createGitHubOAuthAdapter } from "./github.js";
import { createIdentityService } from "./identity.js";
import { createPendingOAuthTxStore } from "./pending-tx.js";
import { createAuthRoutes, type AuthRoutes } from "./routes.js";
import { createSessionService } from "./session.js";

export interface AuthModuleDeps {
  authConfig: AuthConfig;
  db: Db;
  clock: Clock;
  /** Injectable GitHub transport — INTERNAL-ONLY test seam (production
   *  passes neither this nor timeoutMs). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createAuthModule(deps: AuthModuleDeps): AuthRoutes {
  return createAuthRoutes({
    authConfig: deps.authConfig,
    pendingTx: createPendingOAuthTxStore({ clock: deps.clock }),
    github: createGitHubOAuthAdapter({
      clientId: deps.authConfig.githubClientId,
      clientSecret: deps.authConfig.githubClientSecret,
      callbackUrl: deps.authConfig.githubCallbackUrl,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    }),
    identity: createIdentityService({ db: deps.db, clock: deps.clock }),
    sessions: createSessionService({ db: deps.db, clock: deps.clock }),
  });
}

export type { AuthRoutes } from "./routes.js";
