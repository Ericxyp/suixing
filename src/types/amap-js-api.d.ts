declare namespace AMap {
  type LngLatTuple = readonly [longitude: number, latitude: number];
  type LngLatLike = LngLat | LngLatTuple;

  interface MapOptions {
    center?: LngLatLike;
    zoom?: number;
    viewMode?: '2D' | '3D';
  }

  interface MarkerOptions {
    position: LngLatLike;
    title?: string;
    map?: Map;
    content?: string | HTMLElement;
    offset?: Pixel;
    anchor?: 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
    zIndex?: number;
  }

  interface PolylineOptions {
    path: readonly LngLatLike[];
    map?: Map;
    strokeColor?: string;
    strokeWeight?: number;
    strokeOpacity?: number;
    strokeStyle?: 'solid' | 'dashed';
    zIndex?: number;
  }

  class LngLat {
    constructor(longitude: number, latitude: number);
    getLng(): number;
    getLat(): number;
  }

  class Map {
    constructor(container: string | HTMLElement, options?: MapOptions);
    add(overlays: Marker | Polyline | readonly (Marker | Polyline)[]): void;
    remove(overlays: Marker | Polyline | readonly (Marker | Polyline)[]): void;
    setFitView(
      overlays?: readonly (Marker | Polyline)[],
      immediately?: boolean,
      avoid?: readonly number[],
      maxZoom?: number,
    ): void;
    setCenter(center: LngLatLike): void;
    setZoom(zoom: number): void;
    setZoomAndCenter(zoom: number, center: LngLatLike): void;
    resize(): void;
    destroy(): void;
  }

  class Pixel {
    constructor(x: number, y: number);
  }

  class Marker {
    constructor(options: MarkerOptions);
    on(event: 'click', handler: () => void): void;
    off(event: 'click', handler: () => void): void;
    setPosition(position: LngLatLike): void;
    setMap(map: Map | null): void;
  }

  class Polyline {
    constructor(options: PolylineOptions);
    setPath(path: readonly LngLatLike[]): void;
    setMap(map: Map | null): void;
  }
}

interface Window {
  AMap?: typeof AMap;
  _AMapSecurityConfig?: {
    serviceHost: string;
  };
}
