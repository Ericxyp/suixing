import { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Trip } from '../../domain/trip/types';
import { formatCurrency, formatTripDates } from '../../services/trip-display';
import { tripListedDayCount } from '../../repositories/local-trip-storage';

function formatUpdatedAt(value: string): string | undefined {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return undefined;
  }
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日更新`;
}

export function RecentTripsSection({
  trips,
  onDelete,
}: {
  trips: Trip[];
  onDelete: (tripId: string) => void;
}) {
  if (trips.length === 0) {
    return null;
  }

  function confirmDelete(event: MouseEvent<HTMLButtonElement>, trip: Trip) {
    event.preventDefault();
    event.stopPropagation();
    if (window.confirm(`删除「${trip.destination}」这趟旅行？`)) {
      onDelete(trip.id);
    }
  }

  return (
    <section className="home-section recent-trips" aria-labelledby="recent-trips-title">
      <div className="section-heading">
        <h2 id="recent-trips-title">最近行程</h2>
      </div>
      <div className="recent-trip-list">
        {trips.map((trip) => {
          const dayCount = tripListedDayCount(trip);
          const updated = formatUpdatedAt(trip.updatedAt);
          return (
            <article className="recent-trip" key={trip.id}>
              <Link className="recent-trip__link" to={`/trips/${trip.id}`}>
                <p className="recent-trip__destination">{trip.destination}</p>
                <p className="recent-trip__meta">
                  {dayCount ? `${dayCount} 天` : '天数待定'}
                  {' · '}
                  {trip.travelerCount} 人
                  {' · '}
                  预算 {formatCurrency(trip.totalBudget)}
                </p>
                <p className="recent-trip__meta">
                  {updated ?? formatTripDates(trip)}
                </p>
              </Link>
              <button
                className="recent-trip__delete"
                type="button"
                onClick={(event) => confirmDelete(event, trip)}
              >
                删除
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
