import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place, Trip, TripDay } from '../../domain/trip/types';
import {
  AmapJsApiLoadError,
  loadAmapJsApi,
  type AmapJsApi,
} from '../../services/amap-js-loader';
import {
  resolveTripMapRoutes,
  resolveTripMapStops,
  restoreTripMapViewport,
  tripMapMarkerColor,
  TRIP_MAP_ROUTE_COLOR,
  type TripMapStop,
} from '../../services/trip-map';
import { isUsableMapContainer } from '../../services/mobile-viewport';
import { formatDayWorkspaceSummary, dayWorkspaceSummary, visibleUserText } from '../../services/trip-display';
import { ErrorState, LoadingState } from '../common/States';

interface TripMapProps {
  trip: Trip;
  day: TripDay;
  places: readonly Place[];
  selectedTripPlaceId: string | null;
  onStopSelect?: (tripPlaceId: string) => void;
  focusTripPlaceId?: string | null;
  onFocusHandled?: (tripPlaceId: string) => void;
  layoutSignal?: string;
}

type MapStatus = 'loading' | 'ready' | 'missing-key' | 'error';

interface MarkerClickBinding {
  marker: AMap.Marker;
  handler: () => void;
}

const DEFAULT_CENTER: AMap.LngLatTuple = [104.1954, 35.8617];

function removeMarkerClickBindings(bindings: readonly MarkerClickBinding[]): void {
  for (const binding of bindings) {
    binding.marker.off('click', binding.handler);
  }
}

function createPlacePin(stop: TripMapStop, index: number, selected: boolean): HTMLButtonElement {
  const content = document.createElement('button');
  content.type = 'button';
  content.className = `trip-map-pin${selected ? ' trip-map-pin--selected' : ''}`;
  content.setAttribute('aria-pressed', String(selected));
  content.style.setProperty('--pin-color', tripMapMarkerColor(index));
  const order = document.createElement('span');
  order.className = 'trip-map-pin__dot';
  order.textContent = String(index + 1);
  const name = document.createElement('span');
  name.className = 'trip-map-pin__label';
  name.textContent = stop.name;
  content.append(order, name);
  content.setAttribute('aria-label', `${index + 1}. ${stop.name}`);
  return content;
}

export function TripMap({
  trip,
  day,
  places,
  selectedTripPlaceId,
  onStopSelect,
  focusTripPlaceId,
  onFocusHandled,
  layoutSignal,
}: TripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMap.Map | undefined>(undefined);
  const markersRef = useRef<AMap.Marker[]>([]);
  const polylinesRef = useRef<AMap.Polyline[]>([]);
  const markerClickBindingsRef = useRef<MarkerClickBinding[]>([]);
  const markerByTripPlaceIdRef = useRef<Map<string, AMap.Marker>>(new Map());
  const handledFocusRef = useRef<string | null>(null);
  const amapRef = useRef<AmapJsApi | undefined>(undefined);
  const [status, setStatus] = useState<MapStatus>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const stops = useMemo(
    () => resolveTripMapStops(day, places),
    [day, places],
  );
  const routes = useMemo(
    () => resolveTripMapRoutes(trip, day.id),
    [trip, day.id],
  );

  useEffect(() => {
    let active = true;
    let map: AMap.Map | undefined;
    setStatus('loading');

    loadAmapJsApi()
      .then((AMapApi) => {
        if (!active || !containerRef.current) {
          return;
        }
        amapRef.current = AMapApi;
        map = new AMapApi.Map(containerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 4,
          viewMode: '2D',
        });
        mapRef.current = map;
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (
          error instanceof AmapJsApiLoadError
          && error.code === 'AMAP_JS_API_KEY_MISSING'
        ) {
          setStatus('missing-key');
          return;
        }
        setStatus('error');
      });

    return () => {
      active = false;
      if (map) {
        removeMarkerClickBindings(markerClickBindingsRef.current);
        markerClickBindingsRef.current = [];
        markerByTripPlaceIdRef.current.clear();
        if (markersRef.current.length > 0) {
          map.remove(markersRef.current);
          markersRef.current = [];
        }
        if (polylinesRef.current.length > 0) {
          map.remove(polylinesRef.current);
          polylinesRef.current = [];
        }
        map.destroy();
      }
      if (mapRef.current === map) {
        mapRef.current = undefined;
        amapRef.current = undefined;
      }
    };
  }, [loadAttempt]);

  useEffect(() => {
    const map = mapRef.current;
    const AMapApi = amapRef.current;
    if (status !== 'ready' || !map || !AMapApi) {
      return;
    }

    if (markersRef.current.length > 0) {
      removeMarkerClickBindings(markerClickBindingsRef.current);
      markerClickBindingsRef.current = [];
      map.remove(markersRef.current);
    }
    if (polylinesRef.current.length > 0) {
      map.remove(polylinesRef.current);
      polylinesRef.current = [];
    }

    const polylines = routes.map((route) => new AMapApi.Polyline({
      path: route.polyline.map((point) => [point.longitude, point.latitude] as const),
      strokeColor: TRIP_MAP_ROUTE_COLOR,
      strokeWeight: 5,
      strokeOpacity: 0.92,
      zIndex: 12,
    }));
    polylinesRef.current = polylines;
    if (polylines.length > 0) {
      map.add(polylines);
    }

    const markerClickBindings: MarkerClickBinding[] = [];
    const markerByTripPlaceId = new Map<string, AMap.Marker>();
    const markers = stops.map((stop, index) => {
      const selected = stop.tripPlaceId === selectedTripPlaceId;
      const content = createPlacePin(stop, index, selected);
      const marker = new AMapApi.Marker({
        position: [stop.position.longitude, stop.position.latitude],
        title: stop.name,
        content,
        anchor: 'center',
        offset: new AMapApi.Pixel(0, 0),
        zIndex: selected ? 48 + index : 24 + index,
      });
      if (onStopSelect) {
        const handler = () => onStopSelect(stop.tripPlaceId);
        marker.on('click', handler);
        markerClickBindings.push({ marker, handler });
      }
      markerByTripPlaceId.set(stop.tripPlaceId, marker);
      return marker;
    });
    markersRef.current = markers;
    markerClickBindingsRef.current = markerClickBindings;
    markerByTripPlaceIdRef.current = markerByTripPlaceId;

    if (markers.length > 0) {
      map.add(markers);
      restoreTripMapViewport(map, [...polylines, ...markers]);
    }

    return () => {
      if (markersRef.current === markers) {
        removeMarkerClickBindings(markerClickBindings);
        if (markers.length > 0) {
          map.remove(markers);
        }
        markersRef.current = [];
        markerClickBindingsRef.current = [];
        markerByTripPlaceIdRef.current.clear();
      }
      if (polylinesRef.current === polylines && polylines.length > 0) {
        map.remove(polylines);
        polylinesRef.current = [];
      }
    };
  }, [status, stops, routes, selectedTripPlaceId, onStopSelect]);

  useEffect(() => {
    if (!focusTripPlaceId) {
      handledFocusRef.current = null;
      return;
    }
    if (
      status !== 'ready'
      || handledFocusRef.current === focusTripPlaceId
      || !markerByTripPlaceIdRef.current.has(focusTripPlaceId)
    ) {
      return;
    }
    const map = mapRef.current;
    const stop = stops.find(
      (item) => item.tripPlaceId === focusTripPlaceId,
    );
    if (!map || !stop) {
      return;
    }

    handledFocusRef.current = focusTripPlaceId;
    map.setZoomAndCenter(16, [
      stop.position.longitude,
      stop.position.latitude,
    ]);
    onFocusHandled?.(focusTripPlaceId);
  }, [focusTripPlaceId, onFocusHandled, status, stops]);

  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    const map = mapRef.current;
    const canvas = containerRef.current;
    if (!map || !canvas) {
      return;
    }

    let frame: number | null = null;
    let cancelled = false;
    const restoreIfVisible = () => {
      if (cancelled || !isUsableMapContainer(canvas)) {
        return;
      }
      restoreTripMapViewport(map, [...polylinesRef.current, ...markersRef.current]);
    };

    const scheduleRestore = () => {
      if (cancelled || frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          restoreIfVisible();
        });
      });
    };

    scheduleRestore();
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleRestore)
      : undefined;
    observer?.observe(canvas);
    window.addEventListener('orientationchange', scheduleRestore);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scheduleRestore);
    viewport?.addEventListener('scroll', scheduleRestore);
    return () => {
      cancelled = true;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener('orientationchange', scheduleRestore);
      viewport?.removeEventListener('resize', scheduleRestore);
      viewport?.removeEventListener('scroll', scheduleRestore);
    };
  }, [status, layoutSignal, day.id]);

  const overlay = dayWorkspaceSummary(trip, day);
  const overlayText = formatDayWorkspaceSummary({
    placeCount: stops.length,
    transitMinutes: overlay.transitMinutes,
  });
  const overlayTitle = overlay.transitMinutes === undefined ? '今日地点' : '今日路线';
  const currentStop = stops.find((stop) => stop.tripPlaceId === selectedTripPlaceId)
    ?? stops[0];
  const currentName = visibleUserText(currentStop?.name);
  const missingCount = day.places.length - stops.length;

  return (
    <section className="trip-map" aria-label={`Day ${day.dayNumber} 地图`} data-trip-map="primary">
      <div className="trip-map__frame">
        <div
          className="trip-map__canvas"
          ref={containerRef}
          aria-label="行程地点地图"
        />
        {status === 'loading' && (
          <div className="trip-map__state">
            <LoadingState label="正在加载地图…" />
          </div>
        )}
        {status === 'missing-key' && (
          <div className="trip-map__state">
            <p className="state-message">地图服务尚未配置</p>
          </div>
        )}
        {status === 'error' && (
          <div className="trip-map__state">
            <ErrorState
              message="地图暂时无法加载，请稍后重试"
              onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
            />
          </div>
        )}
        {status === 'ready' && stops.length === 0 && (
          <div className="trip-map__state trip-map__state--subtle">
            <p className="state-message">这一天暂时没有可显示的地点</p>
          </div>
        )}
        {status === 'ready' && stops.length > 0 && overlayText && (
          <div className="trip-map__summary">
            <div>
              <strong>{overlayTitle}</strong>
              <span>{overlayText}</span>
            </div>
            {currentName && <p className="trip-map__summary-current">当前：{currentName}</p>}
          </div>
        )}
      </div>
      {status === 'ready' && missingCount > 0 && stops.length > 0 && (
        <p className="trip-map__notice">
          部分地点暂无坐标，地图仅显示可定位的行程地点。
        </p>
      )}
    </section>
  );
}
