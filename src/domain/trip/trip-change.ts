import type { TransportSegment, Trip, TripDay, TripPlace } from './types';

export type TripChangeStatus =
  | 'DRAFT'
  | 'PENDING_CONFIRMATION'
  | 'APPLIED'
  | 'CANCELLED'
  | 'EXPIRED';

export type TripChangeOperationType = 'ADD' | 'REMOVE' | 'REPLACE' | 'MOVE' | 'UPDATE';

export interface TripChangeOperation {
  type: TripChangeOperationType;
  dayId: string;
  targetTripPlaceId?: string;
  replacementPlaceId?: string;
  payload?: Record<string, unknown>;
}

export interface TripChange {
  id: string;
  tripId: string;
  status: TripChangeStatus;
  operations: TripChangeOperation[];
  beforeSnapshot: Partial<Trip>;
  afterPreview: Partial<Trip>;
  costDelta: number;
  timeDeltaMinutes: number;
  reason?: string;
  createdAt: string;
}

type TripPlacePayload = Omit<TripPlace, 'id' | 'dayId'> & { id?: string; dayId?: string };
type EditableTripPlaceField = Pick<
  TripPlace,
  | 'startTime'
  | 'endTime'
  | 'durationMinutes'
  | 'description'
  | 'estimatedCost'
  | 'transportToNext'
  | 'placeName'
  | 'type'
>;

const tripPlaceTypes: readonly TripPlace['type'][] = [
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
];

function isTransportSegment(value: unknown): value is TransportSegment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const segment = value as Record<string, unknown>;
  return typeof segment.mode === 'string'
    && ['walk', 'metro', 'taxi', 'bus', 'drive'].includes(segment.mode)
    && typeof segment.durationMinutes === 'number'
    && typeof segment.distanceMeters === 'number'
    && (segment.description === undefined || typeof segment.description === 'string');
}

function isTripPlacePayload(value: unknown): value is TripPlacePayload {
  return typeof value === 'object' && value !== null && 'placeId' in value && 'placeName' in value;
}

function isEditableTripPlacePayload(value: unknown): value is Partial<EditableTripPlaceField> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const editableFields = new Set<keyof EditableTripPlaceField>([
    'startTime',
    'endTime',
    'durationMinutes',
    'description',
    'estimatedCost',
    'transportToNext',
    'placeName',
    'type',
  ]);
  const keys = Object.keys(payload);

  if (keys.length === 0 || keys.some((key) => !editableFields.has(key as keyof EditableTripPlaceField))) {
    return false;
  }
  if (payload.startTime !== undefined && typeof payload.startTime !== 'string') return false;
  if (payload.endTime !== undefined && typeof payload.endTime !== 'string') return false;
  if (payload.durationMinutes !== undefined && typeof payload.durationMinutes !== 'number') return false;
  if (payload.description !== undefined && typeof payload.description !== 'string') return false;
  if (payload.estimatedCost !== undefined && typeof payload.estimatedCost !== 'number') return false;
  if (payload.placeName !== undefined && typeof payload.placeName !== 'string') return false;
  if (payload.type !== undefined && (!tripPlaceTypes.includes(payload.type as TripPlace['type']))) return false;
  if (payload.transportToNext !== undefined && !isTransportSegment(payload.transportToNext)) return false;
  return true;
}

function cloneTrip(trip: Trip): Trip {
  return structuredClone(trip);
}

function getDay(days: TripDay[], dayId: string): TripDay {
  const day = days.find((candidate) => candidate.id === dayId);
  if (!day) {
    throw new Error(`Trip day "${dayId}" was not found.`);
  }
  return day;
}

function normaliseOrders(places: TripPlace[]): TripPlace[] {
  return places.map((place, index) => ({ ...place, order: index + 1 }));
}

function updateDay(days: TripDay[], dayId: string, places: TripPlace[]): TripDay[] {
  return days.map((day) => (day.id === dayId ? { ...day, places: normaliseOrders(places) } : day));
}

function requireTargetPlace(day: TripDay, targetTripPlaceId: string, operation: TripChangeOperationType): TripPlace {
  const target = day.places.find((place) => place.id === targetTripPlaceId);
  if (!target) {
    throw new Error(`${operation} target TripPlace "${targetTripPlaceId}" was not found in day "${day.id}".`);
  }
  return target;
}

/**
 * Applies structural place operations without mutating the persisted Trip.
 * Route recalculation is deliberately delegated to a future RouteProvider.
 */
export function applyTripChangePreview(trip: Trip, change: TripChange): Trip {
  if (trip.id !== change.tripId) {
    throw new Error('TripChange does not belong to the supplied Trip.');
  }

  const nextTrip = cloneTrip(trip);

  for (const operation of change.operations) {
    const day = getDay(nextTrip.days, operation.dayId);

    if (operation.type === 'REMOVE') {
      if (!operation.targetTripPlaceId) {
        throw new Error('REMOVE requires targetTripPlaceId.');
      }
      requireTargetPlace(day, operation.targetTripPlaceId, operation.type);
      nextTrip.days = updateDay(
        nextTrip.days,
        operation.dayId,
        day.places.filter((place) => place.id !== operation.targetTripPlaceId),
      );
      continue;
    }

    if (operation.type === 'ADD') {
      if (!isTripPlacePayload(operation.payload)) {
        throw new Error('ADD requires a TripPlace payload.');
      }
      const payload = operation.payload;
      const insertionOrder = Math.min(Math.max(payload.order || day.places.length + 1, 1), day.places.length + 1);
      const place: TripPlace = {
        ...payload,
        id: payload.id ?? `preview-${change.id}-${operation.replacementPlaceId ?? payload.placeId}`,
        dayId: day.id,
        order: insertionOrder,
      };
      if (day.places.some((candidate) => candidate.id === place.id)) {
        throw new Error(`ADD TripPlace id "${place.id}" already exists in day "${day.id}".`);
      }
      nextTrip.days = updateDay(nextTrip.days, operation.dayId, [
        ...day.places.slice(0, insertionOrder - 1),
        place,
        ...day.places.slice(insertionOrder - 1),
      ]);
      continue;
    }

    if (operation.type === 'REPLACE') {
      if (!operation.targetTripPlaceId || !isTripPlacePayload(operation.payload)) {
        throw new Error('REPLACE requires targetTripPlaceId and a TripPlace payload.');
      }
      const payload = operation.payload;
      requireTargetPlace(day, operation.targetTripPlaceId, operation.type);
      nextTrip.days = updateDay(
        nextTrip.days,
        operation.dayId,
        day.places.map((place) =>
          place.id === operation.targetTripPlaceId
            ? { ...payload, id: place.id, dayId: day.id, order: place.order }
            : place,
        ),
      );
      continue;
    }

    if (operation.type === 'MOVE') {
      if (!operation.targetTripPlaceId || typeof operation.payload?.order !== 'number') {
        throw new Error('MOVE requires targetTripPlaceId and a numeric payload.order.');
      }
      const target = requireTargetPlace(day, operation.targetTripPlaceId, operation.type);
      const destinationIndex = Math.min(Math.max(Math.trunc(operation.payload.order), 1), day.places.length) - 1;
      const remainingPlaces = day.places.filter((place) => place.id !== target.id);
      remainingPlaces.splice(destinationIndex, 0, target);
      nextTrip.days = updateDay(nextTrip.days, operation.dayId, remainingPlaces);
      continue;
    }

    if (operation.type === 'UPDATE') {
      if (!operation.targetTripPlaceId) {
        throw new Error('UPDATE requires targetTripPlaceId.');
      }
      if (!isEditableTripPlacePayload(operation.payload)) {
        throw new Error('UPDATE requires a non-empty payload of editable TripPlace fields.');
      }
      requireTargetPlace(day, operation.targetTripPlaceId, operation.type);
      nextTrip.days = updateDay(
        nextTrip.days,
        operation.dayId,
        day.places.map((place) =>
          place.id === operation.targetTripPlaceId ? { ...place, ...operation.payload } : place,
        ),
      );
      continue;
    }

    throw new Error(`Unsupported TripChange operation "${operation.type}".`);
  }

  return {
    ...nextTrip,
    totalBudget: nextTrip.totalBudget + change.costDelta,
  };
}
