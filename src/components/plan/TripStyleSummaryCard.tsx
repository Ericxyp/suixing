import type { Ref } from 'react';
import type { TripStyleViewV1 } from '../../services/trip-style-display';
import {
  TRIP_STYLE_CARD_TITLE,
  TRIP_STYLE_EDIT_LABEL,
  TRIP_STYLE_EMPTY_COPY,
  TRIP_STYLE_FOOTNOTE,
} from '../../services/trip-style-display';

export function TripStyleSummaryCard({
  view,
  locked = false,
  onEdit,
  editButtonRef,
}: {
  view: TripStyleViewV1;
  locked?: boolean;
  onEdit: () => void;
  editButtonRef?: Ref<HTMLButtonElement>;
}) {
  if (!view.visible) {
    return null;
  }
  const lines: string[] = [];
  if (!view.empty) {
    if (view.interestLabels.length > 0) {
      lines.push(view.interestLabels.join(' · '));
    }
    if (view.companionLabels.length > 0) {
      lines.push(view.companionLabels.join(' · '));
    }
    lines.push(view.paceLabel);
    lines.push(...view.avoidLabels);
  }

  return (
    <section className="trip-style-card" aria-label={TRIP_STYLE_CARD_TITLE}>
      <p className="trip-style-card__eyebrow">{TRIP_STYLE_CARD_TITLE}</p>
      {view.empty
        ? <p className="trip-style-card__empty">{TRIP_STYLE_EMPTY_COPY}</p>
        : (
          <ul className="trip-style-card__lines">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      {view.longTermHint && <p className="trip-style-card__habit">{view.longTermHint}</p>}
      <p className="trip-style-card__note">{TRIP_STYLE_FOOTNOTE}</p>
      <button
        type="button"
        className="trip-style-card__edit"
        ref={editButtonRef}
        onClick={onEdit}
        disabled={locked}
      >
        {TRIP_STYLE_EDIT_LABEL}
      </button>
    </section>
  );
}
