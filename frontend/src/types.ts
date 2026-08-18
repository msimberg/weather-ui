// Field names mirror the Pirate Weather API (Dark Sky compatible) so the
// backend can pass responses through without a translation layer. Everything
// is optional: which fields are present depends on data block, source models,
// and whether version=2 additions are available at the location.

export type Units = "si" | "us" | "ca" | "uk" | "uk2";

export interface HourPoint {
  time: number;
  summary?: string;
  icon?: string;
  precipIntensity?: number;
  precipProbability?: number;
  precipIntensityError?: number;
  precipAccumulation?: number;
  precipType?: string;
  rainIntensity?: number;
  snowIntensity?: number;
  iceIntensity?: number;
  liquidAccumulation?: number;
  snowAccumulation?: number;
  iceAccumulation?: number;
  temperature?: number;
  apparentTemperature?: number;
  feelsLike?: number;
  dewPoint?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  windGust?: number;
  windBearing?: number;
  cloudCover?: number;
  uvIndex?: number;
  visibility?: number;
  ozone?: number;
  smoke?: number;
  cape?: number;
  solar?: number;
  fireIndex?: number;
  airQualityIndex?: number;
  nearestStormDistance?: number;
  nearestStormBearing?: number;
}

export interface DayPoint extends HourPoint {
  sunriseTime?: number;
  sunsetTime?: number;
  dawnTime?: number;
  duskTime?: number;
  moonPhase?: number;
  temperatureHigh?: number;
  temperatureHighTime?: number;
  temperatureLow?: number;
  temperatureLowTime?: number;
  temperatureMin?: number;
  temperatureMax?: number;
  apparentTemperatureHigh?: number;
  apparentTemperatureLow?: number;
  apparentTemperatureMin?: number;
  apparentTemperatureMax?: number;
  precipIntensityMax?: number;
  precipIntensityMaxTime?: number;
  uvIndexTime?: number;
  windGustTime?: number;
  smokeMax?: number;
  fireIndexMax?: number;
  capeMax?: number;
  solarMax?: number;
}

export interface MinutePoint {
  time: number;
  precipIntensity?: number;
  precipProbability?: number;
  precipType?: string;
}

export interface Alert {
  title: string;
  severity?: string;
  time: number;
  expires: number;
  description: string;
  uri?: string;
  regions?: string[];
}

export interface DataBlock<T> {
  summary?: string;
  icon?: string;
  data: T[];
}

export interface WeatherPayload {
  latitude: number;
  longitude: number;
  timezone: string;
  offset: number;
  elevation?: number;
  currently?: HourPoint;
  minutely?: DataBlock<MinutePoint>;
  hourly?: DataBlock<HourPoint>;
  daily?: DataBlock<DayPoint>;
  alerts?: Alert[];
  flags?: {
    sources?: string[];
    units?: string;
    version?: string;
    sourceTimes?: Record<string, string>;
  };
  /** Open-Meteo altitude-layered cloud cover, 0..100 percent values. */
  cloudLayers?: {
    time: number[];
    low: number[];
    mid: number[];
    high: number[];
  };
  meta?: {
    mergedPastDays?: number;
    warnings?: string[];
  };
}

export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
}

export interface CurrentLocation {
  name: string;
  lat: number;
  lon: number;
}
