/**
 * Identity fields we can read off a Codex / Grok OAuth credential.
 * Codex puts email on the access-token profile claim. Grok often has none
 * until userinfo is fetched; labels must still never be a UUID.
 */

export const CODEX_AUTH_KEY = "openai-codex";
export const XAI_AUTH_KEY = "xai-oauth";
export const MULTI_OAUTH_AUTH_KEYS = [CODEX_AUTH_KEY, XAI_AUTH_KEY] as const;
export type MultiOauthAuthKey = (typeof MULTI_OAUTH_AUTH_KEYS)[number];

const CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_PROFILE_CLAIM_PATH = "https://api.openai.com/profile";

export interface OauthAccountIdentity {
  accountId: string;
  email: string;
  displayName: string;
  shortLabel: string;
  matchKey: string;
}

export function normalizeMultiOauthAuthKey(value: unknown): MultiOauthAuthKey | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === CODEX_AUTH_KEY || raw === "openai-codex-oauth") return CODEX_AUTH_KEY;
  if (raw === XAI_AUTH_KEY) return XAI_AUTH_KEY;
  return null;
}

export function isOauthCredential(value: unknown): value is Record<string, any> {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "oauth"
    && typeof (value as { access?: unknown }).access === "string"
    && (value as { access: string }).access.trim().length > 0;
}

export function inspectOauthCredential(
  cred: unknown,
  authKey: MultiOauthAuthKey,
): OauthAccountIdentity | null {
  if (!isOauthCredential(cred)) return null;
  const payload = decodeJwtPayload(String(cred.access || ""));
  const idTokenPayload = decodeJwtPayload(String(cred.idToken || cred.id_token || ""));
  const accountId = firstNonEmpty(
    stringField(cred.accountId),
    stringField(cred.account_id),
    accountIdFromPayload(payload),
    accountIdFromPayload(idTokenPayload),
  );
  const email = firstEmail(
    stringField(cred.email),
    emailFromPayload(payload),
    emailFromPayload(idTokenPayload),
  );
  const accessProfile = asRecord(payload?.[CODEX_PROFILE_CLAIM_PATH]);
  const name = firstNonEmpty(
    humanLabel(stringField(cred.name)),
    humanLabel(stringField(payload?.name)),
    humanLabel(stringField(idTokenPayload?.name)),
    humanLabel(stringField(accessProfile?.name)),
    humanLabel(stringField(payload?.preferred_username)),
  );
  const displayName = firstNonEmpty(
    email,
    name,
    authKey === XAI_AUTH_KEY ? "Grok" : "Codex",
  );
  const matchKey = firstNonEmpty(
    accountId,
    email,
    tokenTail(cred.refresh),
    tokenTail(cred.access),
  );
  return {
    accountId,
    email,
    displayName,
    shortLabel: shortLabelFor(email, displayName),
    matchKey,
  };
}

export function looksLikeOpaqueId(value: unknown): boolean {
  const raw = stringField(value);
  if (!raw || raw.includes("@")) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return true;
  }
  return /^[0-9a-f]{8,}$/i.test(raw);
}

export function resolveOauthAccountLabels(
  source: { email?: unknown; displayName?: unknown },
  authKey: MultiOauthAuthKey,
): { email: string; displayName: string; shortLabel: string } {
  const email = firstEmail(stringField(source.email), stringField(source.displayName));
  const fallback = authKey === XAI_AUTH_KEY ? "Grok" : "Codex";
  const displayName = firstNonEmpty(email, humanLabel(stringField(source.displayName)), fallback);
  return {
    email,
    displayName,
    shortLabel: shortLabelFor(email, displayName) || fallback,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function accountIdFromPayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const openaiAuth = asRecord(payload[CODEX_ACCOUNT_CLAIM_PATH]);
  return firstNonEmpty(
    stringField(openaiAuth?.chatgpt_account_id),
    stringField(payload.chatgpt_account_id),
    stringField(payload.account_id),
    stringField(payload.sub),
  );
}

function emailFromPayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const profile = asRecord(payload[CODEX_PROFILE_CLAIM_PATH]);
  const preferred = stringField(payload.preferred_username);
  return firstEmail(
    stringField(payload.email),
    stringField(profile?.email),
    preferred.includes("@") ? preferred : "",
    firstEmailInList(payload.emails),
  );
}

function firstEmailInList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const item of value) {
    const email = stringField(item);
    if (email.includes("@")) return email;
  }
  return "";
}

function shortLabelFor(email: string, displayName: string): string {
  if (email.includes("@")) {
    const local = email.slice(0, email.indexOf("@")).trim();
    if (local) return clip(local, 12);
  }
  const label = humanLabel(displayName);
  return label ? clip(label, 12) : "";
}

function humanLabel(value: string): string {
  return looksLikeOpaqueId(value) ? "" : value.trim();
}

function firstEmail(...values: string[]): string {
  return values.find(value => value.includes("@")) || "";
}

function tokenTail(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length < 8) return "";
  return `tok:${raw.slice(-16)}`;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find(value => value.length > 0) || "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
