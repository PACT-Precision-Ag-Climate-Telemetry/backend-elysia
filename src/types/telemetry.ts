export interface TelemetryReadingV0 {
  timestamp: number;
  timedif: number;
  temperature: number;
  humidity: number;
  carbon_dioxide: number;
  methane: number;
  /** %LEL. Present only when the payload's has_raw is true. */
  methane_raw?: number;
  offset: number;
  depth: number;
  moisture: number;
  /** Present only when the payload's has_raw is true. */
  moisture_raw?: number;
  battery_voltage: number;
  battery_percentage: number;
  esp_temperature: number;
  status: number;
  status_flags: string[];
}

export interface TelemetryPayloadV0 {
  id: string;
  version: string;
  flags: number;
  readings: TelemetryReadingV0[];
  has_raw: boolean;
  has_gps: boolean;
  latitude?: number;
  longitude?: number;
  has_cell: boolean;
  mobile_country_code?: number;
  mobile_network_code?: number;
  signal_strength: number;
  reset_reason: number;
  reset_reason_name: string;
}

export interface IngestErrorPayloadV0 {
  source: string;
  error: string;
  payload: string;
}
