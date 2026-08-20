export const OBSERVATIONAL_NOTES_TYPE = "hana.om.notes";

export const OBSERVATION_RELEVANCE = Object.freeze(["high", "medium", "low"]);

export type ObservationRelevance = "high" | "medium" | "low";

export type Observation = {
  id: string;
  content: string;
  relevance: ObservationRelevance;
  timestamp: string;
};

export type ObservationalNotesData = {
  schema: 1;
  observations: Observation[];
  coveredThroughEntryId: string | null;
};

export function isObservationRelevance(value: unknown): value is ObservationRelevance {
  return value === "high" || value === "medium" || value === "low";
}
