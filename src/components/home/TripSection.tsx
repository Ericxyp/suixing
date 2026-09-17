import { Link } from 'react-router-dom';
import type { Trip } from '../../domain/trip/types';
import { TripStatusLabel } from './TripStatusLabel';

function formatDateRange(trip: Trip): string {
  if (!trip.startDate || !trip.endDate) return '日期待定';
  const format = (date: string) => {
    const [, month, day] = date.split('-');
    return `${Number(month)}月${Number(day)}日`;
  };
  return `${format(trip.startDate)}—${format(trip.endDate)}`;
}

function duration(trip: Trip): string {
  if (!trip.startDate || !trip.endDate) return '行程待定';
  const days = Math.round(
    (Date.parse(`${trip.endDate}T00:00:00Z`) - Date.parse(`${trip.startDate}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  return `${days}天${Math.max(days - 1, 0)}晚`;
}

export function TripSection({
  title,
  trips,
  planningAction = false,
}: {
  title: string;
  trips: Trip[];
  planningAction?: boolean;
}) {
  return (
    <section className="home-section" aria-labelledby={`section-${title}`}>
      <div className="section-heading">
        <h2 id={`section-${title}`}>{title}</h2>
      </div>
      {trips.length === 0 ? (
        <p className="state-message">暂时还没有旅行。开始一趟旅行吧。</p>
      ) : (
        <div className="trip-list">
          {trips.map((trip) => (
            <Link className="trip-card" key={trip.id} to={`/trips/${trip.id}`}>
              <div>
                <p className="trip-card__title">{trip.title}</p>
                <p className="trip-card__meta">{formatDateRange(trip)} · {duration(trip)}</p>
                <p className="trip-card__meta">{trip.travelerCount}人 · 预算 ¥{trip.totalBudget.toLocaleString('zh-CN')}</p>
              </div>
              <div className="trip-card__aside">
                <TripStatusLabel status={trip.status} />
                {planningAction && <span className="trip-action">继续规划 →</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
