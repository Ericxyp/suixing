import type { PlaceProvider, RouteProvider } from '../domain/trip/providers';
import { BffHttpClient, type FetchLike } from '../services/bff-client';
import { AmapPlaceProvider } from './amap-place-provider';
import { AmapRouteProvider } from './amap-route-provider';
import { MockPlaceProvider, MockRouteProvider } from './mock-providers';

export interface TravelProviders {
  placeProvider: PlaceProvider;
  routeProvider: RouteProvider;
}

export function createMockTravelProviders(): TravelProviders {
  return {
    placeProvider: new MockPlaceProvider(),
    routeProvider: new MockRouteProvider(),
  };
}

export function createAmapTravelProviders(options?: {
  client?: BffHttpClient;
  fetch?: FetchLike;
}): TravelProviders {
  const client = options?.client
    ?? (options?.fetch ? new BffHttpClient(options.fetch) : new BffHttpClient());
  return {
    placeProvider: new AmapPlaceProvider(client),
    routeProvider: new AmapRouteProvider(client),
  };
}

/** 应用默认数据源。后续阶段需显式注入 AMap Provider，不能隐式降级到 Mock。 */
export const defaultTravelProviders = createMockTravelProviders();
