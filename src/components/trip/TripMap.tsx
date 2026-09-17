import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place, Trip, TripDay } from '../../domain/trip/types';
import {
  AmapJsApiLoadError,
  loadAmapJsApi,
  type AmapJsApi,
} from '../../services/amap-js-loader';
import {
  resolveTripMapStops,
  TRIP_PLACE_TYPE_LABELS,
  type TripMapStop,
} from '../../services/trip-map';
import { ErrorState, LoadingState } from '../common/States';

interface TripMapProps {
  trip: Trip;
  day: TripDay;
  places: readonly Place[];
  selectedTripPlaceId: string | null;
  onStopSelect?: (tripPlaceId: string) => void;
  focusTripPlaceId?: string | null;
  onFocusHandled?: (tripPlaceId: string) => void;
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

function createPlaceCard(stop: TripMapStop, index: number, selected: boolean): HTMLButtonElement {
  const content = document.createElement('button');
  content.type = 'button';
  content.className = `trip-map-place-card${selected ? ' trip-map-place-card--selected' : ''}`;
  content.setAttribute('aria-pressed', String(selected));
  const order = document.createElement('span');
  order.className = 'trip-map-place-card__order';
  order.textContent = String(index + 1);
  const body = document.createElement('span');
  body.className = 'trip-map-place-card__body';
  const name = document.createElement('span');
  name.className = 'trip-map-place-card__name';
  name.textContent = stop.name;
  const meta = document.createElement('span');
  meta.className = 'trip-map-place-card__meta';
  meta.textContent = `${stop.startTime ?? '时间待定'} · ${TRIP_PLACE_TYPE_LABELS[stop.type]}`;
  body.append(name, meta);
  content.append(order, body);
  content.setAttribute('aria-label', `${index + 1}. ${stop.name}`);
  return content;
}

export function TripMap({
  day,
  places,
  selectedTripPlaceId,
  onStopSelect,
  focusTripPlaceId,
  onFocusHandled,
}: TripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMap.Map | undefined>(undefined);
  const markersRef = useRef<AMap.Marker[]>([]);
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

    const markerClickBindings: MarkerClickBinding[] = [];
    const markerByTripPlaceId = new Map<string, AMap.Marker>();
    const markers = stops.map((stop, index) => {
      const selected = stop.tripPlaceId === selectedTripPlaceId;
      const content = createPlaceCard(stop, index, selected);
      const marker = new AMapApi.Marker({
        position: [stop.position.longitude, stop.position.latitude],
        title: stop.name,
        content,
        anchor: 'bottom-left',
        offset: new AMapApi.Pixel(index * 10, -index * 8),
        zIndex: selected ? 40 + index : 20 + index,
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
      map.setFitView(markers, true, [48, 48, 120, 48], 15);
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
    };
  }, [status, stops, selectedTripPlaceId, onStopSelect]);

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

  const missingCount = day.places.length - stops.length;

  return (
    <section className="trip-map" aria-label={`Day ${day.dayNumber} 地图`}>
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
        {status === 'ready' && stops.length > 0 && (
          <div className="trip-map__summary">
            <strong>今日地点</strong>
            <span>{stops.length} 个地点</span>
          </div>
        )}
      </div>
      {status === 'ready' && stops.length > 0 && (
        <p className="trip-map__hint">点击地点卡片，在行程中查看详情</p>
      )}
      {status === 'ready' && missingCount > 0 && stops.length > 0 && (
        <p className="trip-map__notice">
          部分地点暂无坐标，地图仅显示可定位的行程地点。
        </p>
      )}
    </section>
  );
}
