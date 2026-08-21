/**
 * The agent environment whitelist (Phase 2 batch 2, plan §2.4): the child
 * process sees EXACTLY the allow-listed variables — never LOOPZHB_* (machine
 * credential, run tokens, server URL), cloud/CI keys, or anything else the
 * operator's shell happens to carry. secretValues feeds redactSecrets so
 * error text entering reports/logs never embeds a credential.
 */

export interface AgentEnv {
  env: Record<string, string>;
  secretValues: string[];
}

/** Exact-name allowances (system + TLS + Claude non-prefixed). */
const EXACT_ALLOW: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
]);

/** Proxy variables in BOTH cases (curl and friends honor either). */
const PROXY_NAMES: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

/** Prefix allowances: locale and the Anthropic/Claude surface. */
const PREFIX_ALLOW: readonly string[] = ["LC_", "ANTHROPIC_"];

/** ALLOW-list semantics: absence is the default. LOOPZHB_*, GITHUB_TOKEN,
 *  AWS_*, GOOGLE_*, OPENAI_API_KEY, run tokens and everything else the shell
 *  carries simply never match. */
function isAllowed(key: string): boolean {
  return EXACT_ALLOW.has(key) || PROXY_NAMES.has(key) || PREFIX_ALLOW.some((prefix) => key.startsWith(prefix));
}

/** Which FORWARDED values are credentials: non-empty ANTHROPIC_* and the
 *  OAuth token are obvious; proxy URLs can embed userinfo. PATH/HOME/LANG
 *  are never secrets. */
function isSecretKey(key: string): boolean {
  return key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_OAUTH_TOKEN" || PROXY_NAMES.has(key);
}

function isSecret(key: string, value: string): boolean {
  return value !== "" && isSecretKey(key);
}

/** Longest-first, deduped, empties dropped — replacing a short secret before
 *  an overlapping longer one would leave the tail of the longer behind. */
function normalizeSecrets(values: string[]): string[] {
  return [...new Set(values)].filter((value) => value !== "").sort((a, b) => b.length - a.length);
}

export function buildAgentEnv(source: NodeJS.ProcessEnv): AgentEnv {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !isAllowed(key)) continue;
    env[key] = value;
    if (isSecret(key, value)) secrets.push(value);
  }
  return { env, secretValues: normalizeSecrets(secrets) };
}

/** Startup capability probes need PATH/config/TLS compatibility, but never
 * authenticate or contact the provider. Removing every credential-bearing
 * key limits a substituted local executable to an unauthenticated process;
 * the real Run receives the full agent allow-list only after identity
 * revalidation. */
export function buildProbeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const { env } = buildAgentEnv(source);
  for (const key of Object.keys(env)) {
    if (isSecretKey(key)) delete env[key];
  }
  return env;
}

/** Chars treated as chunk separators by the tolerant pass: an exfiltrator
 *  splits an encoded secret into chunks joined by whitespace/punctuation
 *  (chunked base64 defeats exact matching, round-2 review P1). Needles are
 *  stripped of the same class, so a needle containing one of these chars
 *  (base64's `/`, base64url's `-_`) still matches consistently. */
const SEPARATORS = new Set([..." \t\n\r\f\v:;.,|~*_-/\\"]);

function stripSeparators(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!SEPARATORS.has(ch)) out += ch;
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pick a one-byte ASCII boundary which cannot be part of any protected raw
 *  or derived form, even under case-insensitive matching, or be stripped by
 *  the tolerant pass. It prevents fragments/adjacent markers from joining
 *  into another form without growing UTF-8 wire bytes. Exhausting the safe
 *  ASCII set is handled fail-closed by dropping the whole text. */
function chooseBoundaryMarker(protectedForms: readonly string[]): string | null {
  for (let codePoint = 0x21; codePoint <= 0x7e; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint);
    const foldedCandidate = candidate.toLowerCase();
    if (
      candidate !== '"' && // JSON would escape it and grow the wire body
      !SEPARATORS.has(candidate) &&
      protectedForms.every((form) => !form.toLowerCase().includes(foldedCandidate))
    ) {
      return candidate;
    }
  }
  return null;
}

/** Separator-tolerant redaction: strip separators from the text (keeping a
 *  source-index map), search the PLAIN needles in the compressed view, and
 *  redact the corresponding spans — separators included — in the original.
 *  Case-insensitive needles (hex, percent) search a lowercased view built in
 *  the same pass (multi-char lowercase expansions map to the same source
 *  index, so span mapping stays exact). A span ends at the last NEEDLE char:
 *  trailing separator-class chars of the leak may survive it — they carry no
 *  decodable content on their own. */
function redactTolerant(
  text: string,
  needlesCS: readonly string[],
  needlesCI: readonly string[],
  marker: string,
): string {
  const strippedChars: string[] = [];
  const strippedMap: number[] = [];
  const loweredChars: string[] = [];
  const loweredMap: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (SEPARATORS.has(ch)) continue;
    strippedChars.push(ch);
    strippedMap.push(i);
    for (const lc of ch.toLowerCase()) {
      loweredChars.push(lc);
      loweredMap.push(i);
    }
  }
  const stripped = strippedChars.join("");
  const lowered = loweredChars.join("");
  /** Spans in ORIGINAL-text coordinates: [start, end). */
  const spans: Array<[number, number]> = [];
  const collect = (haystack: string, map: number[], needle: string): void => {
    let from = 0;
    for (;;) {
      const idx = haystack.indexOf(needle, from);
      if (idx < 0) return;
      spans.push([map[idx]!, map[idx + needle.length - 1]! + 1]);
      from = idx + needle.length;
    }
  };
  for (const needle of needlesCS) collect(stripped, strippedMap, needle);
  for (const needle of needlesCI) collect(lowered, loweredMap, needle);
  if (spans.length === 0) return text;

  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  let [spanStart, spanEnd] = spans[0]!;
  const emit = (): void => {
    out += `${text.slice(cursor, spanStart)}${marker}`;
    cursor = spanEnd;
  };
  for (let i = 1; i < spans.length; i += 1) {
    const [s, e] = spans[i]!;
    if (s <= spanEnd) {
      spanEnd = Math.max(spanEnd, e); // overlapping spans merge
    } else {
      emit();
      [spanStart, spanEnd] = [s, e];
    }
  }
  emit();
  return out + text.slice(cursor);
}

/** Replace every occurrence of every non-empty secret with a boundary marker. Match
 *  forms: raw and JSON-escaped, plus — at realistic secret length
 *  (≥ 8), where a short secret's encodings would vandalize ordinary text —
 *  base64 / base64url / hex / second-order base64 / percent-encoded
 *  (round-2 review P1: a Bash child can pipe a credential through a
 *  deterministic encoder before it reaches progress/finalText). Encoded and
 *  raw forms ALSO match separator-chunked (whitespace/punctuation between
 *  chunks) via a strip-and-map pass, hex and percent case-insensitively.
 *
 *  The exact pass is a SINGLE combined-regex replacement: replacements never
 *  feed another pass. Every match becomes the same protected-form-absent,
 *  non-separator, one-byte ASCII boundary. Thus UTF-8 output never grows and
 *  fragments (including adjacent replacements) cannot rejoin a raw or
 *  supported derived form.
 *
 *  Documented residual (ADR-006 决策 6): transforms WITHOUT a deterministic
 *  plaintext form — compression (gzip headers embed non-determinism),
 *  encryption, custom alphabets, deeper nesting — stay out of scope; the
 *  structural mitigation is that Bash's network allowlist is empty and the
 *  only egress is the report/progress channel to the operator's own server.
 *  All forms are normalized together (longest-first, deduped, empties
 *  dropped). Caller contract: redact BEFORE serializing structured fields,
 *  and raw child env/stdout never enters logs unscrubbed. */
export function redactSecrets(text: string, secretValues: string[]): string {
  const secrets = normalizeSecrets(secretValues);
  if (secrets.length === 0 || text === "") return text;

  const exactForms = new Set<string>();
  const tolerantCS: string[] = [];
  const tolerantCI: string[] = [];
  for (const secret of secrets) {
    exactForms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1); // body without quotes
    if (escaped !== secret) exactForms.add(escaped);
    if (secret.length < 8) continue;
    const bytes = Buffer.from(secret, "utf8");
    const b64 = bytes.toString("base64");
    const b64url = bytes.toString("base64url");
    const hexLower = bytes.toString("hex");
    const nestedB64 = Buffer.from(b64, "utf8").toString("base64");
    const nestedB64url = Buffer.from(b64url, "utf8").toString("base64url");
    const percent = encodeURIComponent(secret);
    for (const form of [b64, b64url, hexLower, hexLower.toUpperCase(), nestedB64, nestedB64url, percent]) {
      exactForms.add(form);
    }
    for (const form of [secret, b64, b64url, nestedB64, nestedB64url, percent]) {
      const needle = stripSeparators(form);
      if (needle.length >= 12) tolerantCS.push(needle);
    }
    for (const form of [hexLower, percent.toLowerCase()]) {
      const needle = stripSeparators(form);
      if (needle.length >= 12) tolerantCI.push(needle);
    }
  }

  const marker = chooseBoundaryMarker([...exactForms, ...tolerantCS, ...tolerantCI]);
  if (marker === null) return "";

  const pattern = [...exactForms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  // Callback form keeps a `$` marker literal instead of invoking replacement
  // string substitutions such as `$&` or `$'`.
  let out = pattern === "" ? text : text.replace(new RegExp(pattern, "g"), () => marker);
  if (tolerantCS.length > 0 || tolerantCI.length > 0) {
    out = redactTolerant(out, [...new Set(tolerantCS)], [...new Set(tolerantCI)], marker);
  }
  return out;
}
