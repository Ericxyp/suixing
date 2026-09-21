import type {
  GeoPoint,
  Place,
  TransportMode,
  Trip,
  TripDay,
  TripPlaceType,
} from '../domain/trip/types';

export const TRIP_PLACE_TYPE_LABELS: Record<TripPlaceType, string> = {
  hotel: '酒店',
  attraction: '景点',
  restaurant: '餐厅',
  cafe: '咖啡',
  transport: '交通',
  shopping: '购物',
  activity: '活动',
};

export interface TripMapStop {
  tripPlaceId: string;
  order: number;
  name: string;
  type: TripPlaceType;
  startTime?: string;
  position: GeoPoint;
}

export interface TripMapRoute {
  routeId: string;
  fromTripPlaceId: string;
  toTripPlaceId: string;
  mode: TransportMode;
  distanceMeters: number;
  durationMinutes: number;
  polyline: GeoPoint[];
}

export interface TripMapRouteSummary {
  routeCount: number;
  totalDistanceMeters: number;
  totalDurationMinutes: number;
}

export type TripMapSelectionSource = 'map' | 'timeline' | null;

export function shouldScrollTimelineForSelection(
  source: TripMapSelectionSource,
): boolean {
  return source === 'map';
}

export function shouldFocusMapForSelection(
  source: TripMapSelectionSource,
): boolean {
  return source === 'timeline';
}

export function isTripPlaceInDay(
  day: TripDay,
  tripPlaceId: string | null,
): boolean {
  return (
    tripPlaceId !== null
    && day.places.some((place) => place.id === tripPlaceId)
  );
}

export function retainSelectedTripPlaceId(
  day: TripDay,
  tripPlaceId: string | null,
): string | null {
  return isTripPlaceInDay(day, tripPlaceId) ? tripPlaceId : null;
}

export function shouldClearSelectionAfterReplace(
  selectedTripPlaceId: string | null,
  replacedTripPlaceId: string,
): boolean {
  return selectedTripPlaceId !== null && selectedTripPlaceId === replacedTripPlaceId;
}

function isValidGeoPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180
  );
}

function isSamePoint(left: GeoPoint, right: GeoPoint): boolean {
  return (
    left.latitude === right.latitude
    && left.longitude === right.longitude
  );
}

export function resolveTripMapStops(
  day: TripDay,
  places: readonly Place[],
): TripMapStop[] {
  const placesById = new Map(places.map((place) => [place.id, place]));

  return [...day.places]
    .sort((left, right) => left.order - right.order)
    .flatMap((tripPlace) => {
      const place = placesById.get(tripPlace.placeId);
      if (!place || !isValidGeoPoint(place)) {
        return [];
      }
      return [{
        tripPlaceId: tripPlace.id,
        order: tripPlace.order,
        name: tripPlace.placeName,
        type: tripPlace.type,
        ...(tripPlace.startTime ? { startTime: tripPlace.startTime } : {}),
        position: {
          latitude: place.latitude,
          longitude: place.longitude,
        },
      }];
    });
}

export function getTripMapStopByTripPlaceId(
  day: TripDay,
  places: readonly Place[],
  tripPlaceId: string,
): TripMapStop | null {
  return (
    resolveTripMapStops(day, places)
      .find((stop) => stop.tripPlaceId === tripPlaceId)
    ?? null
  );
}

export function resolveTripMapRoutes(
  trip: Trip,
  dayId: string,
): TripMapRoute[] {
  return trip.routes.flatMap((route) => {
    if (route.dayId !== dayId || !route.polyline) {
      return [];
    }

    const polyline = route.polyline.reduce<GeoPoint[]>((points, point) => {
      if (!isValidGeoPoint(point)) {
        return points;
      }
      const copiedPoint = {
        latitude: point.latitude,
        longitude: point.longitude,
      };
      const previous = points[points.length - 1];
      if (!previous || !isSamePoint(previous, copiedPoint)) {
        points.push(copiedPoint);
      }
      return points;
    }, []);

    if (polyline.length < 2) {
      return [];
    }

    return [{
      routeId: route.id,
      fromTripPlaceId: route.fromTripPlaceId,
      toTripPlaceId: route.toTripPlaceId,
      mode: route.transport.mode,
      distanceMeters: route.transport.distanceMeters,
      durationMinutes: route.transport.durationMinutes,
      polyline,
    }];
  });
}

export const TRIP_MAP_ROUTE_COLOR = '#3B82F6';
export const TRIP_MAP_MARKER_COLORS = ['#3B82F6', '#F59E0B', '#8B5CF6', '#F97316'] as const;

export function tripMapMarkerColor(index: number): string {
  return TRIP_MAP_MARKER_COLORS[index % TRIP_MAP_MARKER_COLORS.length];
}

const MAP_FIT_PADDING = [56, 48, 132, 48] as const;

export function restoreTripMapViewport(
  map: Pick<AMap.Map, 'setFitView' | 'resize'>,
  overlays: readonly (AMap.Marker | AMap.Polyline)[],
): void {
  if (typeof map.resize === 'function') {
    map.resize();
  }
  if (overlays.length > 0) {
    map.setFitView(overlays, true, MAP_FIT_PADDING, 15);
  }
}

export function summarizeTripMapRoutes(
  routes: readonly TripMapRoute[],
): TripMapRouteSummary {
  return routes.reduce<TripMapRouteSummary>(
    (summary, route) => ({
      routeCount: summary.routeCount + 1,
      totalDistanceMeters:
        summary.totalDistanceMeters + route.distanceMeters,
      totalDurationMinutes:
        summary.totalDurationMinutes + route.durationMinutes,
    }),
    {
      routeCount: 0,
      totalDistanceMeters: 0,
      totalDurationMinutes: 0,
    },
  );
}
