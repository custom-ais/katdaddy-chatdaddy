declare module 'leaflet.gridlayer.googlemutant' {
  import { GridLayer, GridLayerOptions } from 'leaflet';
  export default class GoogleMutant extends GridLayer {
    constructor(options?: GridLayerOptions & { type?: 'roadmap' | 'satellite' | 'terrain' | 'hybrid'; maxZoom?: number });
  }
}
