import type { TripStatus } from '../../domain/trip/types';

const labels: Record<TripStatus, string> = {
  PLANNING: '规划中',
  READY: '已就绪',
  TRAVELLING: '旅行中',
  COMPLETED: '已完成',
};

export function TripStatusLabel({ status }: { status: TripStatus }) {
  return <span className="trip-status">{labels[status]}</span>;
}
