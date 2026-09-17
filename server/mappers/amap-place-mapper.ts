import type { Place, TripPlaceType } from '../../src/domain/trip/types';
import type { AmapPoiDto } from '../types/amap';

export function parseAmapLocation(location: string): { longitude: number; latitude: number } | null {
  const parts = location.split(',').map((part) => part.trim());
  if (parts.length !== 2 || !/^-?\d+(?:\.\d+)?$/.test(parts[0]) || !/^-?\d+(?:\.\d+)?$/.test(parts[1])) return null;
  const [longitude, latitude] = parts.map(Number);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90 ? { longitude, latitude } : null;
}
export function mapAmapPoiCategory(poi: AmapPoiDto): TripPlaceType {
  const text = `${poi.type ?? ''} ${poi.typecode ?? ''}`;
  if (/酒店|宾馆|住宿/.test(text)) return 'hotel';
  if (/咖啡/.test(text)) return 'cafe';
  if (/餐饮|餐厅|小吃|饭店/.test(text)) return 'restaurant';
  if (/购物|商场|商店/.test(text)) return 'shopping';
  if (/交通|火车站|地铁站|机场|汽车站|虹桥站/.test(text)) return 'transport';
  if (/风景|景点|博物馆|公园|展览|文化/.test(text)) return 'attraction';
  return 'activity';
}
export function mapAmapPoiToPlace(poi: AmapPoiDto): Place | null {
  const id = poi.id?.trim(); const name = poi.name?.trim(); const coordinates = poi.location ? parseAmapLocation(poi.location) : null;
  if (!id || !name || !coordinates) return null;
  const address = Array.isArray(poi.address) ? poi.address.map((part) => part.trim()).filter(Boolean).join(' ') : poi.address?.trim();
  return { id: `amap:${id}`, provider: 'amap', providerPlaceId: id, name, address: address || '地址待补充', latitude: coordinates.latitude, longitude: coordinates.longitude, category: mapAmapPoiCategory(poi) };
}
