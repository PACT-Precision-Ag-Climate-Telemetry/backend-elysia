export interface TelemetryReadingV0 {
  timestamp: number;
  timedif: number;
  temperature: number;
  humidity: number;
  pressure: number;
  carbon_dioxide: number;
  methane_raw: number;
  methane: number;
  offset: number;
  depth: number;
  moisture_raw: number;
  moisture: number;
  battery_voltage: number;
  battery_percentage: number;
  status: number;
  error_code: number;
}

export interface TelemetryPayloadV0 {
  id: string;
  version: string;
  flags: number;
  readings: TelemetryReadingV0[];
  has_gps: boolean;
  latitude?: number;
  longitude?: number;
  has_cell: boolean;
  mobile_country_code?: number;
  mobile_network_code?: number;
}

export interface IngestErrorPayloadV0 {
  source: string;
  error: string;
  payload: string;
}
