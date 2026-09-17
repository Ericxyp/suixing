import type { GeoPoint, TransportSegment } from '../../src/domain/trip/types';
import {
  mapAmapDrivingRoute,
  mapAmapWalkingRoute,
} from '../mappers/amap-route-mapper';
import type { AmapDirectionResponse } from '../types/amap';
import { AmapProviderError, type AmapHttpClient } from './amap-http-client';

export interface RoutePlanningInput {
  origin: GeoPoint;
  destination: GeoPoint;
  mode: 'walk' | 'taxi';
  signal?: AbortSignal;
}

export interface RouteResult {
  transport: TransportSegment;
  polyline: GeoPoint[];
}

export interface AmapRouteService {
  plan(input: RoutePlanningInput): Promise<RouteResult>;
}

const INVALID_REQUEST_MESSAGE = '路线参数无效，请调整后重试。';
const PROVIDER_ERROR_MESSAGE = '路线服务暂时不可用，请稍后重试。';

function isGeoPoint(value: unknown): value is GeoPoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const point = value as Partial<GeoPoint>;
  return (
    typeof point.latitude === 'number'
    && Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && typeof point.longitude === 'number'
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180
  );
}

function serializePoint(point: GeoPoint): string {
  return `${point.longitude},${point.latitude}`;
}

export class AmapWebServiceRouteService implements AmapRouteService {
  constructor(private readonly client: AmapHttpClient) {}

  async plan(input: RoutePlanningInput): Promise<RouteResult> {
    if (
      !input
      || !isGeoPoint(input.origin)
      || !isGeoPoint(input.destination)
      || (input.mode !== 'walk' && input.mode !== 'taxi')
    ) {
      throw new AmapProviderError('INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
    }

    const path = input.mode === 'taxi'
      ? '/v3/direction/driving'
      : '/v3/direction/walking';

    let response: AmapDirectionResponse;
    try {
      response = await this.client.get<AmapDirectionResponse>(path, {
        origin: serializePoint(input.origin),
        destination: serializePoint(input.destination),
      }, input.signal ? { signal: input.signal } : undefined);
    } catch (error) {
      if (error instanceof AmapProviderError) {
        throw error;
      }
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    const route = input.mode === 'taxi'
      ? mapAmapDrivingRoute(response)
      : mapAmapWalkingRoute(response);
    if (!route) {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }
    return route;
  }
}
