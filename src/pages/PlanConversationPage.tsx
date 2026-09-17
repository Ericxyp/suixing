import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PlanConversation } from '../components/plan/PlanConversation';
import { TravelSummary } from '../components/plan/TravelSummary';
import type { TripRequirementDraft } from '../domain/trip/ai';
import { tripRepository } from '../repositories/local-storage-trip-repository';
import {
  appendUserMessage,
  applyExtractionResult,
  applyGenerationFailure,
  applyGenerationStarted,
  applySummaryDraftUpdate,
  createEmptyPlanConversation,
  extractPlanRequirements,
  isPlanReadyToGenerate,
  noticeForRequirementExtractionError,
  type PlanConversationState,
  type PlanLocationState,
} from '../services/plan-conversation-service';
import { planConversationStore } from '../services/plan-conversation-store';
import {
  PLAN_SAVE_ERROR_MESSAGE,
  clearPlanCreateLocks,
  creationFingerprint,
  createInitialPlanGenerationGate,
  gateAfterDraftChange,
  restorePlanGenerationGate,
  runPlanTripCreate,
  shouldShowPlanCreateRetry,
  type PlanCreateSource,
  type PlanGenerationGate,
} from '../services/plan-generation';
import { tripRequirementDraftStore } from '../services/trip-requirement-draft-store';
import {
  createRequirementExtractionService,
  getTripAiMode,
} from '../services/trip-requirement-service';
import {
  createTripGenerationService,
  getTripGenerationMode,
  noticeForTripGenerationError,
} from '../services/trip-generation-service';

const userId = 'user-demo-001';
const extractionService = createRequirementExtractionService(
  getTripAiMode(import.meta.env.VITE_TRIP_AI_MODE),
);
const tripGenerationService = createTripGenerationService(
  getTripGenerationMode(import.meta.env.VITE_TRIP_GENERATION_MODE),
  { userId, repository: tripRepository },
);
const runningExtractions = new Set<string>();

function extractionLockKey(state: PlanConversationState): string {
  return state.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
}

export function PlanConversationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<PlanConversationState>(createEmptyPlanConversation);
  const [composer, setComposer] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [gate, setGate] = useState<PlanGenerationGate>(createInitialPlanGenerationGate);
  const started = useRef(false);
  const sessionRef = useRef(session);
  const gateRef = useRef(gate);

  function persist(next: PlanConversationState) {
    sessionRef.current = next;
    setSession(next);
    planConversationStore.save(next);
  }

  function updateGate(next: PlanGenerationGate) {
    gateRef.current = next;
    setGate(next);
  }

  async function runExtraction(next: PlanConversationState) {
    const lock = extractionLockKey(next);
    if (!lock || runningExtractions.has(lock)) {
      return;
    }
    runningExtractions.add(lock);
    setExtracting(true);
    setError(null);
    try {
      const result = await extractPlanRequirements(next, extractionService);
      persist(applyExtractionResult(next, result));
    } catch (cause: unknown) {
      setError(noticeForRequirementExtractionError(cause));
      persist(next);
    } finally {
      runningExtractions.delete(lock);
      setExtracting(false);
    }
  }

  async function createFromCurrentDraft(source: PlanCreateSource) {
    const current = sessionRef.current;
    const result = await runPlanTripCreate({
      draft: current.draft,
      gate: gateRef.current,
      source,
      userId,
      createTrip: async (payload) => {
        const generated = await tripGenerationService.generate(payload.requirements);
        await tripRepository.saveGeneratedTrip({
          trip: generated.trip,
          places: generated.places,
        });
        return generated.trip;
      },
      onStarted: (nextGate) => {
        updateGate(nextGate);
        persist(applyGenerationStarted(sessionRef.current));
      },
    });
    if (result.ok || result.reason === 'failed' || result.reason === 'save_failed') {
      updateGate(result.gate);
    }
    if (result.ok) {
      setError(null);
      tripRequirementDraftStore.clear();
      planConversationStore.clear();
      navigate(`/trips/${result.tripId}`, { state: { createdFromPlan: true } });
      return;
    }
    if (result.reason === 'save_failed' || result.reason === 'failed') {
      persist(applyGenerationFailure(sessionRef.current));
    }
    if (result.reason === 'save_failed') {
      setError(PLAN_SAVE_ERROR_MESSAGE);
      return;
    }
    if (result.reason === 'failed') {
      setError(noticeForTripGenerationError(result.error));
    }
  }

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const initialText = (location.state as PlanLocationState | null)?.initialText?.trim();
    const stored = planConversationStore.load();
    if (initialText) {
      navigate('.', { replace: true, state: {} });
      if (stored?.messages[0]?.role === 'user' && stored.messages[0].content === initialText) {
        persist(stored);
        updateGate(restorePlanGenerationGate(stored.draft));
        const hasAssistant = stored.messages.some((message) => message.role === 'assistant');
        if (!hasAssistant) {
          void runExtraction(stored);
        }
        setHydrated(true);
        return;
      }
      clearPlanCreateLocks();
      const next = appendUserMessage(createEmptyPlanConversation(), initialText);
      persist(next);
      updateGate(createInitialPlanGenerationGate());
      void runExtraction(next);
      setHydrated(true);
      return;
    }
    if (stored) {
      persist(stored);
      updateGate(restorePlanGenerationGate(stored.draft));
    }
    setHydrated(true);
  }, [location.state, navigate]);

  const fingerprint = creationFingerprint(session.draft);

  useEffect(() => {
    if (!hydrated || extracting || gateRef.current.status === 'generating') {
      return;
    }
    const nextGate = gateAfterDraftChange(gateRef.current, session.draft);
    updateGate(nextGate);
    if (!fingerprint) {
      setError(null);
      return;
    }
    void createFromCurrentDraft('auto');
  }, [fingerprint, hydrated, extracting]);

  async function submitComposer() {
    if (extracting || gate.status === 'generating') {
      return;
    }
    const next = appendUserMessage(session, composer);
    if (next === session) {
      return;
    }
    setComposer('');
    persist(next);
    await runExtraction(next);
  }

  function commitSummary(draft: TripRequirementDraft, intentMessage: string) {
    if (gate.status === 'generating') {
      return;
    }
    persist(applySummaryDraftUpdate(session, draft, intentMessage));
  }

  function leavePlan() {
    planConversationStore.clear();
    clearPlanCreateLocks();
  }

  const ready = isPlanReadyToGenerate(session.draft);
  const generating = gate.status === 'generating';
  const showRetry = shouldShowPlanCreateRetry(gate);

  return (
    <div className="plan-shell">
      <header className="plan-header">
        <Link className="brand" to="/" onClick={leavePlan}>随行</Link>
        <Link className="plan-header__back" to="/" onClick={leavePlan}>返回首页</Link>
      </header>
      <div className="plan-layout">
        <details
          className="travel-summary-fold"
          open={summaryOpen}
          onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
        >
          <summary>本次旅行{ready ? ' · 信息已齐全' : ''}</summary>
          <TravelSummary
            draft={session.draft}
            complete={ready}
            locked={generating}
            onDraftCommit={commitSummary}
          />
        </details>
        <PlanConversation
          state={session}
          composerValue={composer}
          onComposerChange={setComposer}
          onSubmit={() => void submitComposer()}
          extracting={extracting}
          generating={generating}
          generationStatus={gate.status}
          error={error}
          showRetry={showRetry}
          onRetry={() => void createFromCurrentDraft('retry')}
        />
        <div className="travel-summary-desktop">
          <TravelSummary
            draft={session.draft}
            complete={ready}
            locked={generating}
            onDraftCommit={commitSummary}
          />
        </div>
      </div>
    </div>
  );
}
