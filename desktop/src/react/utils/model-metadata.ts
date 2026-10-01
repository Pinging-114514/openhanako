import knownModelFallbacks from '../../../../lib/known-model-fallbacks.json';
import knownModels from '../../../../lib/known-models.json';
import { lookupReferenceMetadata } from '../../../../shared/model-reference-lookup.ts';

export interface ModelReferenceMeta {
  name?: string;
  displayName?: string;
  context?: number;
  maxOutput?: number;
  image?: boolean;
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  _source?: 'reference';
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMeta(value: unknown): ModelReferenceMeta | null {
  if (!isRecord(value)) return null;
  return { ...value, _source: 'reference' } as ModelReferenceMeta;
}

export function lookupReferenceModelMeta(modelId: string, provider?: string): ModelReferenceMeta | null {
  return normalizeMeta(lookupReferenceMetadata(
    knownModels as Record<string, unknown>,
    knownModelFallbacks as Record<string, unknown>,
    provider,
    modelId,
  ));
}
