import type { Trip } from '../../domain/trip/types';
import {
  formatCurrency,
  formatTripDates,
  tripPaceLabel,
  tripPreferenceTags,
} from '../../services/trip-display';

export function TripHero({ trip }: { trip: Trip }) {
  const tags = tripPreferenceTags(trip);
  return (
    <header className="trip-hero">
      <div className="trip-hero__copy">
        <p className="trip-hero__eyebrow">随行 · {trip.destination}</p>
        <h1>{trip.title}</h1>
        <p className="trip-hero__meta">
          {formatTripDates(trip)}
          {' · '}
          {trip.travelerCount} 人
          {' · '}
          预算 {formatCurrency(trip.totalBudget)}
          {' · '}
          {tripPaceLabel[trip.pace]}
        </p>
      </div>
      {tags.length > 0 && (
        <ul className="trip-hero__tags">
          {tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
    </header>
  );
}
