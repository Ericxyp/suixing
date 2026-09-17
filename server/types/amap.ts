export interface AmapPoiDto { id?: string; name?: string; address?: string | string[]; location?: string; type?: string; typecode?: string; }

export interface AmapPlaceTextSearchResponse {
  status?: string;
  info?: string;
  pois?: AmapPoiDto[];
}

export type AmapPlaceDetailResponse = AmapPlaceTextSearchResponse;

export interface AmapRouteStepDto {
  polyline?: string;
  road?: string;
  instruction?: string;
}

export interface AmapRoutePathDto {
  distance?: string | number;
  duration?: string | number;
  steps?: AmapRouteStepDto[];
}

export interface AmapDirectionResponse {
  status?: string;
  info?: string;
  route?: {
    paths?: AmapRoutePathDto[];
  };
}
