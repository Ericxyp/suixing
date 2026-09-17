import type { Place } from '../../src/domain/trip/types';
import { mapAmapPoiToPlace } from '../mappers/amap-place-mapper';
import type {
  AmapPlaceDetailResponse,
  AmapPlaceTextSearchResponse,
} from '../types/amap';
import { AmapProviderError, type AmapHttpClient, type AmapQueryValue } from './amap-http-client';

export interface PlaceSearchInput {
  query: string;
  city?: string;
  limit: number;
  signal?: AbortSignal;
}

export interface AmapPlaceService {
  search(input: PlaceSearchInput): Promise<Place[]>;
  getByProviderPlaceId(providerPlaceId: string): Promise<Place | null>;
}

const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';
const INVALID_ID_MESSAGE = '地点编号无效，请调整后重试。';
const PROVIDER_PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function parseProviderPlaceId(providerPlaceId: string): string | null {
  const id = providerPlaceId.trim();
  if (id !== providerPlaceId || !PROVIDER_PLACE_ID_PATTERN.test(id)) {
    return null;
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class AmapWebServicePlaceService implements AmapPlaceService {
  constructor(private readonly client: AmapHttpClient) {}

  async search(input: PlaceSearchInput): Promise<Place[]> {
    const city = input.city?.trim();
    const params: Record<string, AmapQueryValue> = {
      keywords: input.query.trim(),
      offset: input.limit,
      page: 1,
      extensions: 'base',
    };
    if (city) {
      params.city = city;
      params.citylimit = true;
    }

    let response: AmapPlaceTextSearchResponse;
    try {
      response = await this.client.get<AmapPlaceTextSearchResponse>(
        '/v3/place/text',
        params,
        input.signal ? { signal: input.signal } : undefined,
      );
    } catch (error) {
      if (error instanceof AmapProviderError) {
        throw error;
      }
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    if (!isRecord(response) || response.status !== '1') {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    const pois = response.pois;
    if (pois === undefined) {
      return [];
    }
    if (!Array.isArray(pois)) {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    return pois.flatMap((poi) => {
      const place = mapAmapPoiToPlace(poi);
      return place ? [place] : [];
    });
  }

  async getByProviderPlaceId(providerPlaceId: string): Promise<Place | null> {
    const id = parseProviderPlaceId(providerPlaceId);
    if (id === null) {
      throw new AmapProviderError('INVALID_REQUEST', INVALID_ID_MESSAGE);
    }

    let response: AmapPlaceDetailResponse;
    try {
      response = await this.client.get<AmapPlaceDetailResponse>(
        '/v3/place/detail',
        {
          id,
          extensions: 'base',
        },
      );
    } catch (error) {
      if (error instanceof AmapProviderError) {
        throw error;
      }
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    if (!isRecord(response) || response.status !== '1') {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    const pois = response.pois;
    if (pois === undefined) {
      return null;
    }
    if (!Array.isArray(pois)) {
      throw new AmapProviderError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }

    for (const poi of pois) {
      const place = mapAmapPoiToPlace(poi);
      if (place) {
        return place;
      }
    }
    return null;
  }
}
