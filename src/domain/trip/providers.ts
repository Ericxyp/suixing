import type { Place, TransportMode, TransportSegment } from './types';

export interface PlaceProvider {
  search(query: string, city?: string): Promise<Place[]>;
  getById(providerPlaceId: string): Promise<Place | null>;
}

export interface RouteProvider {
  getRoute(input: {
    from: Place;
    to: Place;
    mode?: TransportMode;
  }): Promise<TransportSegment>;
}

export interface HotelProvider {}

export interface FlightProvider {}

export interface TrainProvider {}

export interface TicketProvider {}
