import type { TripRequirementDraft } from '../domain/trip/ai';
import type { CreateTripInput } from '../repositories/trip-repository';
import { isPlanReadyToGenerate, toCreateTripRequirements } from './plan-conversation-service';

export type PlanGenerationStatus =
  | 'collecting'
  | 'ready'
  | 'generating'
  | 'failed'
  | 'completed';

export type PlanCreateSource = 'auto' | 'retry';

export interface PlanGenerationGate {
  status: PlanGenerationStatus;
  fingerprint: string | null;
  lastCreatedFingerprint: string | null;
  failedFingerprint: string | null;
  skipAutoStart: boolean;
}

const createLocks = {
  inFlight: new Set<string>(),
  created: new Set<string>(),
};

function sortedList(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].map((item) => item.trim()).filter(Boolean).sort();
}

export function createInitialPlanGenerationGate(): PlanGenerationGate {
  return {
    status: 'collecting',
    fingerprint: null,
    lastCreatedFingerprint: null,
    failedFingerprint: null,
    skipAutoStart: false,
  };
}

export function creationFingerprint(draft: TripRequirementDraft): string | null {
  const requirements = toCreateTripRequirements(draft);
  if (!requirements || !isPlanReadyToGenerate(draft)) {
    return null;
  }
  return JSON.stringify({
    destination: requirements.destination,
    origin: requirements.origin ?? null,
    startDate: requirements.startDate ?? null,
    endDate: requirements.endDate ?? null,
    durationDays: requirements.durationDays ?? null,
    travelerCount: requirements.travelerCount,
    totalBudget: requirements.totalBudget,
    pace: requirements.pace,
    preferences: {
      interests: sortedList(requirements.preferences?.interests),
      accommodation: sortedList(requirements.preferences?.accommodation),
      mustVisit: sortedList(requirements.preferences?.mustVisit),
      avoid: sortedList(requirements.preferences?.avoid),
    },
    tripIntent: requirements.tripIntent ?? null,
    partyContext: requirements.partyContext ?? null,
    constraints: requirements.constraints ?? null,
    profileSignals: requirements.profileSignals ?? null,
  });
}

export function restorePlanGenerationGate(draft: TripRequirementDraft): PlanGenerationGate {
  const fingerprint = creationFingerprint(draft);
  return {
    status: fingerprint ? 'ready' : 'collecting',
    fingerprint,
    lastCreatedFingerprint: null,
    failedFingerprint: null,
    skipAutoStart: true,
  };
}

export function gateAfterDraftChange(
  previous: PlanGenerationGate,
  draft: TripRequirementDraft,
): PlanGenerationGate {
  const fingerprint = creationFingerprint(draft);
  if (previous.status === 'generating') {
    return { ...previous, fingerprint: previous.fingerprint };
  }
  if (!fingerprint) {
    return {
      ...previous,
      fingerprint: null,
      status: 'collecting',
      failedFingerprint: null,
      skipAutoStart: false,
    };
  }
  if (fingerprint === previous.lastCreatedFingerprint) {
    return {
      ...previous,
      fingerprint,
      status: previous.status === 'completed' ? 'completed' : 'ready',
      skipAutoStart: true,
    };
  }
  if (fingerprint !== previous.fingerprint) {
    return {
      ...previous,
      fingerprint,
      status: 'ready',
      failedFingerprint: null,
      skipAutoStart: false,
    };
  }
  return { ...previous, fingerprint };
}

export function decidePlanCreate(
  gate: PlanGenerationGate,
  source: PlanCreateSource,
): boolean {
  if (!gate.fingerprint) {
    return false;
  }
  if (gate.status === 'generating' || gate.status === 'completed') {
    return false;
  }
  if (gate.fingerprint === gate.lastCreatedFingerprint) {
    return false;
  }
  if (createLocks.inFlight.has(gate.fingerprint) || createLocks.created.has(gate.fingerprint)) {
    return false;
  }
  if (source === 'retry') {
    return gate.status === 'failed' || gate.skipAutoStart;
  }
  if (gate.skipAutoStart || gate.status === 'failed') {
    return false;
  }
  return true;
}

export function shouldShowPlanCreateRetry(gate: PlanGenerationGate): boolean {
  return decidePlanCreate(gate, 'retry');
}

export function tryBeginPlanCreate(fingerprint: string): boolean {
  if (!fingerprint || createLocks.inFlight.has(fingerprint) || createLocks.created.has(fingerprint)) {
    return false;
  }
  createLocks.inFlight.add(fingerprint);
  return true;
}

export function finishPlanCreate(fingerprint: string, outcome: 'created' | 'failed'): void {
  createLocks.inFlight.delete(fingerprint);
  if (outcome === 'created') {
    createLocks.created.add(fingerprint);
  }
}

export function clearPlanCreateLocks(): void {
  createLocks.inFlight.clear();
  createLocks.created.clear();
}

export function beginGenerating(gate: PlanGenerationGate, fingerprint: string): PlanGenerationGate {
  return {
    ...gate,
    fingerprint,
    status: 'generating',
    skipAutoStart: false,
  };
}

export function completeGenerating(gate: PlanGenerationGate, fingerprint: string): PlanGenerationGate {
  return {
    ...gate,
    fingerprint,
    status: 'completed',
    lastCreatedFingerprint: fingerprint,
    failedFingerprint: null,
    skipAutoStart: true,
  };
}

export function failGenerating(gate: PlanGenerationGate, fingerprint: string): PlanGenerationGate {
  return {
    ...gate,
    fingerprint,
    status: 'failed',
    failedFingerprint: fingerprint,
    skipAutoStart: false,
  };
}

export async function runPlanTripCreate(input: {
  draft: TripRequirementDraft;
  gate: PlanGenerationGate;
  source: PlanCreateSource;
  userId: string;
  createTrip: (payload: CreateTripInput) => Promise<{ id: string }>;
  saveTrip?: (trip: { id: string }) => Promise<unknown>;
  onStarted?: (gate: PlanGenerationGate) => void;
}): Promise<
  | { ok: true; tripId: string; gate: PlanGenerationGate }
  | {
    ok: false;
    reason: 'blocked' | 'invalid' | 'failed' | 'save_failed';
    gate: PlanGenerationGate;
    error?: unknown;
  }
> {
  const fingerprint = creationFingerprint(input.draft);
  const requirements = toCreateTripRequirements(input.draft);
  const gated = { ...input.gate, fingerprint };
  if (!fingerprint || !requirements || !decidePlanCreate(gated, input.source)) {
    return {
      ok: false,
      reason: fingerprint && requirements ? 'blocked' : 'invalid',
      gate: input.gate,
    };
  }
  if (!tryBeginPlanCreate(fingerprint)) {
    return { ok: false, reason: 'blocked', gate: gated };
  }
  const generating = beginGenerating(gated, fingerprint);
  input.onStarted?.(generating);
  let created: { id: string } | undefined;
  try {
    created = await input.createTrip({
      userId: input.userId,
      requirements,
    });
    if (input.saveTrip) {
      await input.saveTrip(created);
    }
    finishPlanCreate(fingerprint, 'created');
    return {
      ok: true,
      tripId: created.id,
      gate: completeGenerating(generating, fingerprint),
    };
  } catch (error) {
    finishPlanCreate(fingerprint, 'failed');
    return {
      ok: false,
      reason: created ? 'save_failed' : 'failed',
      gate: failGenerating(generating, fingerprint),
      error,
    };
  }
}

export const PLAN_CREATE_ERROR_MESSAGE = '暂时无法生成旅行方案，请稍后重试。';
export const PLAN_SAVE_ERROR_MESSAGE = '暂时无法保存旅行方案，请重试。';
export const PLAN_CREATING_PLACEHOLDER = '正在生成，可稍候修改';
