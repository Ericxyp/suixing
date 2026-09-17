import type { RouteProvider } from '../domain/trip/providers';
import type {
  GeoPoint,
  Place,
  TransportMode,
  TransportSegment,
} from '../domain/trip/types';
import { BffClientError, type BffClient } from '../services/bff-client';

export const DEFAULT_ROUTE_MODE: Extract<TransportMode, 'walk'> = 'walk';
export const SUPPORTED_ROUTE_MODES = ['walk', 'taxi'] as const;

export type SupportedRouteMode = (typeof SUPPORTED_ROUTE_MODES)[number];

export interface RouteResult {
  transport: TransportSegment;
  polyline: GeoPoint[];
}

const ROUTE_PATH = '/api/routes';
const INVALID_REQUEST_MESSAGE = '路线参数无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const PROVIDER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const SUPPORTED_MODE_SET = new Set<TransportMode>(SUPPORTED_ROUTE_MODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isGeoPoint(value: unknown): value is GeoPoint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && isFiniteNumber(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180
  );
}

function hasValidPlaceCoordinates(place: Place): boolean {
  return isGeoPoint({
    latitude: place.latitude,
    longitude: place.longitude,
  });
}

function isSupportedMode(mode: TransportMode): mode is SupportedRouteMode {
  return SUPPORTED_MODE_SET.has(mode);
}

function toInternalPoint(point: GeoPoint): GeoPoint {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
  };
}

function toInternalTransport(transport: TransportSegment): TransportSegment {
  return {
    mode: transport.mode,
    durationMinutes: transport.durationMinutes,
    distanceMeters: transport.distanceMeters,
    ...(transport.description === undefined
      ? {}
      : { description: transport.description }),
  };
}

function readRouteResult(payload: unknown): RouteResult {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.route)) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }

  const { transport, polyline } = payload.data.route;
  if (!isRecord(transport) || !Array.isArray(polyline) || polyline.length < 2) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }

  if (
    typeof transport.mode !== 'string'
    || !isSupportedMode(transport.mode as TransportMode)
    || !isFiniteNumber(transport.durationMinutes)
    || transport.durationMinutes < 0
    || !isFiniteNumber(transport.distanceMeters)
    || transport.distanceMeters < 0
    || (transport.description !== undefined && typeof transport.description !== 'string')
    || !polyline.every(isGeoPoint)
  ) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }

  return {
    transport: toInternalTransport({
      mode: transport.mode as SupportedRouteMode,
      durationMinutes: transport.durationMinutes,
      distanceMeters: transport.distanceMeters,
      description: transport.description as string | undefined,
    }),
    polyline: polyline.map((point) => toInternalPoint(point)),
  };
}

function resolveMode(mode?: TransportMode): SupportedRouteMode {
  if (mode === undefined) {
    return DEFAULT_ROUTE_MODE;
  }
  if (!isSupportedMode(mode)) {
    throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
  }
  return mode;
}

export class AmapRouteProvider implements RouteProvider {
  constructor(private readonly client: BffClient) {}

  async getRoute(input: {
    from: Place;
    to: Place;
    mode?: TransportMode;
  }): Promise<TransportSegment> {
    const result = await this.getRouteResult(input);
    return result.transport;
  }

  async getRouteResult(input: {
    from: Place;
    to: Place;
    mode?: TransportMode;
  }): Promise<RouteResult> {
    const mode = resolveMode(input.mode);
    if (!hasValidPlaceCoordinates(input.from) || !hasValidPlaceCoordinates(input.to)) {
      throw new BffClientError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }

    let payload: unknown;
    try {
      payload = await this.client.get(ROUTE_PATH, {
        originLng: input.from.longitude,
        originLat: input.from.latitude,
        destinationLng: input.to.longitude,
        destinationLat: input.to.latitude,
        mode,
      });
    } catch (error) {
      if (error instanceof BffClientError) {
        throw error;
      }
      throw new BffClientError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    return readRouteResult(payload);
  }
}
