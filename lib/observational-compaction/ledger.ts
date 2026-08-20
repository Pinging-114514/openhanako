import {
  OBSERVATIONAL_NOTES_TYPE,
  isObservationRelevance,
  type Observation,
  type ObservationalNotesData,
} from "./types.ts";

function asEntry(entry: any) {
  return entry && typeof entry === "object" ? entry : null;
}

export function isObservationalNotesEntry(entry: any): boolean {
  const item = asEntry(entry);
  return item?.type === "custom" && item.customType === OBSERVATIONAL_NOTES_TYPE;
}

export function normalizeObservation(raw: any, fallbackTimestamp: string): Observation | null {
  const content = typeof raw?.content === "string" ? raw.content.replace(/\s+/g, " ").trim() : "";
  if (!content) return null;
  const relevance = isObservationRelevance(raw?.relevance) ? raw.relevance : "medium";
  const timestamp = typeof raw?.timestamp === "string" && raw.timestamp.trim()
    ? raw.timestamp.trim()
    : fallbackTimestamp;
  const id = typeof raw?.id === "string" && /^[a-zA-Z0-9_-]{6,24}$/.test(raw.id)
    ? raw.id
    : nextObservationId();
  return { id, content: content.slice(0, 400), relevance, timestamp };
}

export function nextObservationId(): string {
  return `om_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function foldObservationalNotes(entries: any[]): ObservationalNotesData {
  const observations: Observation[] = [];
  const seen = new Set<string>();
  let coveredThroughEntryId: string | null = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObservationalNotesEntry(entry)) continue;
    const data = entry.data;
    if (!data || data.schema !== 1 || !Array.isArray(data.observations)) continue;
    if (typeof data.coveredThroughEntryId === "string" && data.coveredThroughEntryId.trim()) {
      coveredThroughEntryId = data.coveredThroughEntryId.trim();
    }
    for (const item of data.observations) {
      const note = normalizeObservation(item, new Date().toISOString());
      if (!note || seen.has(note.id) || seen.has(note.content)) continue;
      seen.add(note.id);
      seen.add(note.content);
      observations.push(note);
    }
  }
  return { schema: 1, observations, coveredThroughEntryId };
}

export function parseObservationsJson(text: string, fallbackTimestamp = new Date().toISOString()): Observation[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeObservation(item, fallbackTimestamp))
      .filter(Boolean) as Observation[];
  } catch {
    return [];
  }
}

export function sourceEntriesAfter(entries: any[], coveredThroughEntryId: string | null): any[] {
  const list = Array.isArray(entries) ? entries : [];
  if (!coveredThroughEntryId) return list.filter(isSourceEntry);
  const idx = list.findIndex((entry) => entry?.id === coveredThroughEntryId);
  const start = idx >= 0 ? idx + 1 : 0;
  return list.slice(start).filter(isSourceEntry);
}

export function isSourceEntry(entry: any): boolean {
  const item = asEntry(entry);
  if (!item || item.type === "custom" || item.type === "compaction" || item.type === "session") return false;
  if (item.type === "message") {
    const role = item.message?.role || item.role;
    return role === "user" || role === "assistant";
  }
  return item.type === "message" || item.role === "user" || item.role === "assistant";
}

export function serializeSourceEntries(entries: any[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const role = entry?.message?.role || entry?.role;
    const content = textFromContent(entry?.message?.content ?? entry?.content);
    if (!content) continue;
    const label = role === "user" ? "User" : "Assistant";
    parts.push(`[${label}]\n${content.slice(0, 4000)}`);
  }
  return parts.join("\n\n");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      chunks.push(block);
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string") chunks.push(block.text);
    if (block?.type === "toolCall" && typeof block.name === "string") {
      chunks.push(`(tool ${block.name})`);
    }
  }
  return chunks.join("\n").trim();
}
