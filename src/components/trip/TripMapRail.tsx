import type { ReactNode } from 'react';

export function TripMapRail({
  map,
  action,
}: {
  map: ReactNode;
  action?: ReactNode;
}) {
  return (
    <aside className="trip-map-rail" aria-label="当日地图" data-map-instance="1">
      {map}
      {action && <div className="trip-map-rail__action">{action}</div>}
    </aside>
  );
}
