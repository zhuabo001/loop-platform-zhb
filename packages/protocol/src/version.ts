/**
 * Protocol version anchor. There is deliberately NO negotiation logic: the wire
 * evolves by additive optional fields only (ADR-002), and both peers are tolerant
 * readers (unknown keys stripped, never rejected). Bump only on a breaking change,
 * which the additive rule is designed to make unnecessary.
 */
export const PROTOCOL_VERSION = 1 as const;
