/**
 * Pending OAuth Transaction store (AU1/AU3/AU6 at the unit layer): atomic
 * one-time consumption, lazy 10-minute TTL against the injected Clock,
 * browser-binding id semantics, bounded growth.
 */
import { describe, expect, it } from "vitest";

import { FakeClock } from "../testkit/index.js";
import { createPendingOAuthTxStore, MAX_PENDING_OAUTH_TX, OAUTH_TX_TTL_MS } from "./pending-tx.js";

describe("pending OAuth transaction store", () => {
  it("create mints a random txId with server-side state and PKCE verifier", () => {
    const store = createPendingOAuthTxStore({ clock: new FakeClock() });
    const a = store.create();
    const b = store.create();
    expect(a.txId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.txId).not.toBe(b.txId);
    expect(a.tx.state).not.toBe(b.tx.state);
    expect(a.tx.codeVerifier).not.toBe(b.tx.codeVerifier);
    // PKCE S256 verifier alphabet/length (RFC 7636: 43–128 unreserved chars).
    expect(a.tx.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.size).toBe(2);
  });

  it("consume returns the transaction exactly once (AU6 replay → null)", () => {
    const store = createPendingOAuthTxStore({ clock: new FakeClock() });
    const { txId, tx } = store.create();
    expect(store.consume(txId)).toEqual(tx);
    expect(store.consume(txId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("an unknown txId consumes to null (browser binding: no cookie, no tx)", () => {
    const store = createPendingOAuthTxStore({ clock: new FakeClock() });
    store.create();
    expect(store.consume("f".repeat(32))).toBeNull();
  });

  it("TTL boundary: 1ms before 10 minutes is live, exactly 10 minutes is expired (AU3)", () => {
    const clock = new FakeClock();
    const store = createPendingOAuthTxStore({ clock });
    const live = store.create();
    const dying = store.create();
    clock.advance(OAUTH_TX_TTL_MS - 1);
    expect(store.consume(live.txId)).not.toBeNull();
    clock.advance(1);
    // Exactly at the TTL the transaction is expired — and consume DELETES it.
    expect(store.consume(dying.txId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("an expired transaction is deleted by the consume that finds it", () => {
    const clock = new FakeClock();
    const store = createPendingOAuthTxStore({ clock });
    const { txId } = store.create();
    clock.advance(OAUTH_TX_TTL_MS + 60_000);
    expect(store.consume(txId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("bounded growth: past the cap, expired entries are evicted first, then the oldest live one", () => {
    const clock = new FakeClock();
    const store = createPendingOAuthTxStore({ clock });
    const expired: string[] = [];
    for (let i = 0; i < 10; i++) expired.push(store.create().txId);
    clock.advance(OAUTH_TX_TTL_MS + 1);
    const live: string[] = [];
    for (let i = 0; i < MAX_PENDING_OAUTH_TX - 1; i++) live.push(store.create().txId);
    // Once the running total first hits the cap, the 10 expired entries are
    // evicted mid-loop; no live entry is old enough to drop afterwards.
    expect(store.size).toBe(10 + (MAX_PENDING_OAUTH_TX - 1) - 10);
    // The next create must evict the 10 expired entries, staying under the cap.
    const extra = store.create();
    expect(store.size).toBeLessThanOrEqual(MAX_PENDING_OAUTH_TX);
    // Expired ids are gone even when "consumed" within no further time.
    for (const id of expired) expect(store.consume(id)).toBeNull();
    // Live entries survive, including the newcomer.
    expect(store.consume(extra.txId)).not.toBeNull();
    expect(store.consume(live[live.length - 1]!)).not.toBeNull();
  });

  it("with no expired entries to evict, the OLDEST live transaction is dropped", () => {
    const clock = new FakeClock();
    const store = createPendingOAuthTxStore({ clock });
    const oldest = store.create();
    for (let i = 0; i < MAX_PENDING_OAUTH_TX; i++) store.create();
    expect(store.size).toBe(MAX_PENDING_OAUTH_TX);
    expect(store.consume(oldest.txId)).toBeNull();
  });
});
