export type GenerationStage = 'plan' | 'place_resolve' | 'route_enrich' | 'time_schedule' | 'trip_build' | 'change_interpret' | 'change_apply' | 'meal_apply';

export type GenerationStageOutcome = 'success' | 'failed' | 'timed_out' | 'retried';

export interface GenerationStageLog {
  requestId: string;
  stage: GenerationStage;
  outcome: GenerationStageOutcome;
  durationMs: number;
  errorCode?: string;
  validationReason?: string;
}

export interface GenerationStageLogger {
  logStage(entry: GenerationStageLog): void;
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function safeGenerationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  if (typeof code !== 'string' || !SAFE_ERROR_CODE.test(code)) {
    return undefined;
  }
  return code;
}

export function safeGenerationValidationReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('validationReason' in error)) {
    return undefined;
  }
  const reason = error.validationReason;
  if (typeof reason !== 'string' || !SAFE_ERROR_CODE.test(reason)) {
    return undefined;
  }
  return reason;
}

export function createConsoleGenerationLogger(): GenerationStageLogger {
  return {
    logStage(entry) {
      const validationReason = typeof entry.validationReason === 'string'
        && SAFE_ERROR_CODE.test(entry.validationReason)
        ? entry.validationReason
        : undefined;
      const payload = entry.stage === 'change_apply' || entry.stage === 'meal_apply'
        ? {
          stage: entry.stage,
          outcome: entry.outcome,
          durationMs: entry.durationMs,
          ...(entry.errorCode && SAFE_ERROR_CODE.test(entry.errorCode) ? { errorCode: entry.errorCode } : {}),
          ...(validationReason ? { validationReason } : {}),
        }
        : entry.stage === 'change_interpret'
        ? {
          stage: entry.stage,
          outcome: entry.outcome,
          durationMs: entry.durationMs,
          ...(entry.errorCode && SAFE_ERROR_CODE.test(entry.errorCode) ? { errorCode: entry.errorCode } : {}),
          ...(validationReason ? { validationReason } : {}),
        }
        : {
          requestId: entry.requestId,
          stage: entry.stage,
          outcome: entry.outcome,
          durationMs: entry.durationMs,
          ...(entry.errorCode && SAFE_ERROR_CODE.test(entry.errorCode) ? { errorCode: entry.errorCode } : {}),
          ...(validationReason ? { validationReason } : {}),
        };
      console.info(JSON.stringify(payload));
    },
  };
}

export function createGenerationRequestId(): string {
  return `g${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
