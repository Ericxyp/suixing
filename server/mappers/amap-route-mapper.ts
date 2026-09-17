import type { GeoPoint, TransportMode, TransportSegment } from '../../src/domain/trip/types';
import type { AmapDirectionResponse, AmapRoutePathDto, AmapRouteStepDto } from '../types/amap';
import { parseAmapLocation } from './amap-place-mapper';

export interface MappedAmapRoute {
  transport: TransportSegment;
  polyline: GeoPoint[];
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function samePoint(left: GeoPoint, right: GeoPoint): boolean {
  return left.latitude === right.latitude && left.longitude === right.longitude;
}

function parseStepPolyline(polyline: string | undefined): GeoPoint[] {
  if (!polyline?.trim()) {
    return [];
  }

  const points: GeoPoint[] = [];
  for (const part of polyline.split(';')) {
    const parsed = parseAmapLocation(part.trim());
    if (!parsed) {
      continue;
    }
    const point: GeoPoint = {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
    };
    const previous = points[points.length - 1];
    if (!previous || !samePoint(previous, point)) {
      points.push(point);
    }
  }
  return points;
}

function mergeStepPolylines(steps: AmapRouteStepDto[]): GeoPoint[] {
  const points: GeoPoint[] = [];
  for (const step of steps) {
    const stepPoints = parseStepPolyline(step.polyline);
    if (stepPoints.length === 0) {
      continue;
    }
    for (const point of stepPoints) {
      const previous = points[points.length - 1];
      if (!previous || !samePoint(previous, point)) {
        points.push(point);
      }
    }
  }
  return points;
}

function mapAmapRoute(
  input: AmapDirectionResponse,
  mode: TransportMode,
): MappedAmapRoute | null {
  if (input.status !== '1' || !input.route || !Array.isArray(input.route.paths)) {
    return null;
  }

  const path: AmapRoutePathDto | undefined = input.route.paths[0];
  if (!path || !Array.isArray(path.steps)) {
    return null;
  }

  const distanceMeters = parseNonNegativeNumber(path.distance);
  const durationSeconds = parseNonNegativeNumber(path.duration);
  if (distanceMeters === null || durationSeconds === null) {
    return null;
  }

  const polyline = mergeStepPolylines(path.steps);
  if (polyline.length === 0) {
    return null;
  }

  return {
    transport: {
      mode,
      distanceMeters,
      durationMinutes: Math.round(durationSeconds / 60),
    },
    polyline,
  };
}

export function mapAmapDrivingRoute(input: AmapDirectionResponse): MappedAmapRoute | null {
  return mapAmapRoute(input, 'taxi');
}

export function mapAmapWalkingRoute(input: AmapDirectionResponse): MappedAmapRoute | null {
  return mapAmapRoute(input, 'walk');
}
