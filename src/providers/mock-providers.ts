import type { PlaceProvider, RouteProvider } from '../domain/trip/providers';
import type { Place, TransportMode, TransportSegment } from '../domain/trip/types';
import { mockPlaces } from '../mocks/places';
import { mockShanghaiTrip } from '../mocks/trips';

export class MockPlaceProvider implements PlaceProvider {
  async search(query: string, city?: string): Promise<Place[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return mockPlaces
      .filter((place) => {
        const matchesQuery = place.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery);
        return matchesQuery && (!city || place.address.includes(city));
      })
      .map((place) => structuredClone(place));
  }

  async getById(providerPlaceId: string): Promise<Place | null> {
    const place = mockPlaces.find((candidate) => candidate.providerPlaceId === providerPlaceId);
    return place ? structuredClone(place) : null;
  }
}

export class MockRouteProvider implements RouteProvider {
  async getRoute(input: {
    from: Place;
    to: Place;
    mode?: TransportMode;
  }): Promise<TransportSegment> {
    const route = mockShanghaiTrip.routes.find((candidate) => {
      const from = mockShanghaiTrip.days
        .flatMap((day) => day.places)
        .find((place) => place.id === candidate.fromTripPlaceId);
      const to = mockShanghaiTrip.days
        .flatMap((day) => day.places)
        .find((place) => place.id === candidate.toTripPlaceId);
      return from?.placeId === input.from.id && to?.placeId === input.to.id
        && (!input.mode || candidate.transport.mode === input.mode);
    });

    if (!route) {
      throw new Error(`No mock route exists from "${input.from.id}" to "${input.to.id}".`);
    }
    return structuredClone(route.transport);
  }
}
