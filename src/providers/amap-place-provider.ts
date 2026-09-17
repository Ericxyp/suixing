import type { PlaceProvider } from '../domain/trip/providers';
import type { Place, PlaceProviderName, TripPlaceType } from '../domain/trip/types';
import { BffClientError, type BffClient } from '../services/bff-client';

export const PLACE_SEARCH_LIMIT = 10;
const PLACE_SEARCH_PATH = '/api/places/search';
const INVALID_QUERY_MESSAGE = '搜索条件无效，请调整后重试。';
const INVALID_RESPONSE_MESSAGE = '服务返回结果无效。';
const PLACE_CATEGORIES = new Set<TripPlaceType>([
  'hotel',
  'attraction',
  'restaurant',
  'cafe',
  'transport',
  'shopping',
  'activity',
]);
const PLACE_PROVIDERS = new Set<PlaceProviderName>(['amap', 'mock']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInternalPlace(value: unknown): value is Place {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string'
    && value.id.trim() !== ''
    && typeof value.provider === 'string'
    && PLACE_PROVIDERS.has(value.provider as PlaceProviderName)
    && typeof value.providerPlaceId === 'string'
    && value.providerPlaceId.trim() !== ''
    && typeof value.name === 'string'
    && value.name.trim() !== ''
    && typeof value.address === 'string'
    && isFiniteNumber(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && isFiniteNumber(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180
    && typeof value.category === 'string'
    && PLACE_CATEGORIES.has(value.category as TripPlaceType)
  );
}

function toInternalPlace(place: Place): Place {
  return {
    id: place.id,
    provider: place.provider,
    providerPlaceId: place.providerPlaceId,
    name: place.name,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    category: place.category,
  };
}

const PROVIDER_PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INVALID_ID_MESSAGE = '地点编号无效，请调整后重试。';

function parseProviderPlaceId(providerPlaceId: string): string | null {
  const id = providerPlaceId.trim();
  if (id !== providerPlaceId || !PROVIDER_PLACE_ID_PATTERN.test(id)) {
    return null;
  }
  return id;
}

function readPlacesPayload(payload: unknown): Place[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.places)) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }
  if (!payload.data.places.every(isInternalPlace)) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }
  return payload.data.places.map((place) => toInternalPlace(place));
}

function readPlacePayload(payload: unknown): Place | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !('place' in payload.data)) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }
  if (payload.data.place === null) {
    return null;
  }
  if (!isInternalPlace(payload.data.place)) {
    throw new BffClientError('INVALID_RESPONSE', INVALID_RESPONSE_MESSAGE);
  }
  return toInternalPlace(payload.data.place);
}

export class AmapPlaceProvider implements PlaceProvider {
  private searchCache = new Map<string, Place>();

  constructor(private readonly client: BffClient) {}

  async search(query: string, city?: string): Promise<Place[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery === '') {
      throw new BffClientError('INVALID_REQUEST', INVALID_QUERY_MESSAGE);
    }

    const params: Record<string, string | number> = {
      query: trimmedQuery,
      limit: PLACE_SEARCH_LIMIT,
    };
    const trimmedCity = city?.trim();
    if (trimmedCity) {
      params.city = trimmedCity;
    }

    let payload: unknown;
    try {
      payload = await this.client.get(PLACE_SEARCH_PATH, params);
    } catch (error) {
      if (error instanceof BffClientError) {
        throw error;
      }
      throw new BffClientError('PROVIDER_ERROR', '服务暂时不可用，请稍后重试。');
    }

    const places = readPlacesPayload(payload);
    this.searchCache = new Map(
      places.map((place) => [place.providerPlaceId, toInternalPlace(place)]),
    );
    return places.map((place) => toInternalPlace(place));
  }

  /**
   * 通过 BFF `GET /api/places/:providerPlaceId` 查询真实地点详情。
   * 内存缓存只保存成功结果的本地副本，失败时不会回退到缓存或 Mock。
   */
  async getById(providerPlaceId: string): Promise<Place | null> {
    const id = parseProviderPlaceId(providerPlaceId);
    if (id === null) {
      throw new BffClientError('INVALID_REQUEST', INVALID_ID_MESSAGE);
    }

    let payload: unknown;
    try {
      payload = await this.client.get(`/api/places/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof BffClientError) {
        throw error;
      }
      throw new BffClientError('PROVIDER_ERROR', '服务暂时不可用，请稍后重试。');
    }

    const place = readPlacePayload(payload);
    if (place) {
      this.searchCache.set(place.providerPlaceId, toInternalPlace(place));
    }
    return place ? toInternalPlace(place) : null;
  }
}
