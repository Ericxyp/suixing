import type { RequirementExtractionResult } from '../domain/trip/ai';

const key = 'suixing.pending-trip-requirements';

export function serializeDraft(result: RequirementExtractionResult): string {
  return JSON.stringify(result);
}

export function deserializeDraft(value: string | null): RequirementExtractionResult | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && 'draft' in parsed && 'missingRequiredFields' in parsed
      ? parsed as RequirementExtractionResult
      : null;
  } catch {
    return null;
  }
}

export const tripRequirementDraftStore = {
  save(result: RequirementExtractionResult) {
    sessionStorage.setItem(key, serializeDraft(result));
  },
  load() {
    return deserializeDraft(sessionStorage.getItem(key));
  },
  clear() {
    sessionStorage.removeItem(key);
  },
};
