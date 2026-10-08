/**
 * Pending OAuth Transactions (Batch 3 plan §1): the server-memory record of
 * an in-flight GitHub login. A transaction is created by `GET /auth/github`
 * and consumed ATOMICALLY exactly once by the callback — every callback
 * branch, success or failure, consumes, so a replay finds nothing.
 *
 * Deliberately in-memory only: a server restart invalidates every unfinished
 * login (the user simply restarts the flow), and nothing about the pending
 * state ever touches the database.
 *
 * Browser binding: the cookie carries ONLY the random `txId`; this
 * server-side map stores the expected `state` and PKCE `codeVerifier`.
 * The browser sees and carries `state` in the authorization URL and callback
 * query. The verifier never reaches the browser; the server sends it to
 * GitHub's token endpoint in the exchange body. Binding relies on the txId
 * cookie, one-time consumption of its server-side transaction, and comparison
 * of the callback state with the stored state. It does not rely on keeping
 * state secret from the browser.
 *
 * TTL is LAZY: checked on `consume()` against the injected Clock (no sweeper,
 * no timers). The one addition beyond lazy semantics is a bounded-growth
 * guard on `create()`: past MAX_PENDING transactions, expired entries are
 * evicted first, then the oldest — so abandoned `/auth/github` hits cannot
 * grow the map without bound.
 */
import { createHash, randomBytes } from "node:crypto";

import type { Clock } from "../time.js";

/** PKCE S256 challenge derivation (RFC 7636): base64url of the RAW sha256
 *  digest bytes — not of the hex text. Only this challenge rides the
 *  authorize redirect; the verifier itself leaves the server exactly once —
 *  to GitHub's token endpoint in the exchange body — and never reaches the
 *  browser. */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;
/** Bound on concurrently pending transactions (abandoned-login DoS guard). */
export const MAX_PENDING_OAUTH_TX = 1024;

export interface PendingOAuthTx {
  state: string;
  codeVerifier: string;
  createdAtMs: number;
}

export interface PendingOAuthTxStore {
  create(): { txId: string; tx: PendingOAuthTx };
  /** Get-and-delete in one synchronous step; expired transactions are
   *  deleted and reported as null. A second consume of the same id is null. */
  consume(txId: string): PendingOAuthTx | null;
  /** Live entry count (test introspection). */
  readonly size: number;
}

export function createPendingOAuthTxStore(deps: { clock: Clock }): PendingOAuthTxStore {
  const txs = new Map<string, PendingOAuthTx>();
  const nowMs = (): number => deps.clock.now().getTime();

  function evictIfFull(): void {
    if (txs.size < MAX_PENDING_OAUTH_TX) return;
    const now = nowMs();
    for (const [id, tx] of txs) {
      if (now - tx.createdAtMs >= OAUTH_TX_TTL_MS) txs.delete(id);
    }
    while (txs.size >= MAX_PENDING_OAUTH_TX) {
      // Map iteration order is insertion order: the first key is the oldest.
      const oldest = txs.keys().next();
      if (oldest.done) break;
      txs.delete(oldest.value);
    }
  }

  return {
    create() {
      evictIfFull();
      const txId = randomBytes(16).toString("hex");
      const tx: PendingOAuthTx = {
        state: randomBytes(32).toString("base64url"),
        codeVerifier: randomBytes(32).toString("base64url"),
        createdAtMs: nowMs(),
      };
      txs.set(txId, tx);
      return { txId, tx };
    },
    consume(txId) {
      const tx = txs.get(txId);
      if (tx === undefined) return null;
      txs.delete(txId);
      if (nowMs() - tx.createdAtMs >= OAUTH_TX_TTL_MS) return null;
      return tx;
    },
    get size() {
      return txs.size;
    },
  };
}
