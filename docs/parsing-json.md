# Parsing telemetry JSON in a backend

How to consume the telemetry messages the ingest service publishes to RabbitMQ.
The authoritative contract is [schemas/telemetry-data.schema.json](schemas/telemetry-data.schema.json);
transport details (exchange, routing key) are in [rabbitmq.md](rabbitmq.md).

## 1. What a message looks like

One message is one device upload, containing 1-255 readings, oldest first.

```json
{
  "id": "ABC-DEF-1234",
  "version": "0",
  "flags": 224,
  "readings": [
    {
      "timestamp": 1723000000, "timedif": 300,
      "temperature": 28.5, "humidity": 65.25,
      "carbon_dioxide": 420, "methane": 45, "methane_raw": 1.23,
      "offset": 67, "depth": 89,
      "moisture": 54.25, "moisture_raw": 321,
      "battery_voltage": 3700, "battery_percentage": 85,
      "esp_temperature": 41.25,
      "status": 1, "status_flags": ["battery_read_failed"]
    }
  ],
  "has_raw": true,
  "has_gps": true, "latitude": 13.7563, "longitude": 100.5018,
  "has_cell": true, "mobile_country_code": 520, "mobile_network_code": 1,
  "signal_strength": -85,
  "reset_reason": 9, "reset_reason_name": "brownout"
}
```

## 2. Rules that decide how you model it

| Field(s) | Rule |
|---|---|
| `methane_raw`, `moisture_raw` | Present **only** when `has_raw` is true. Model as optional. |
| `latitude`, `longitude` | Present **only** when `has_gps` is true. |
| `mobile_country_code`, `mobile_network_code` | Present **only** when `has_cell` is true. `0` is a valid MNC, so test for presence, never truthiness. |
| `temperature`, `esp_temperature` | Celsius, can be negative. |
| `methane` | ppm. `methane_raw` is %LEL, a different unit. |
| `signal_strength` | dBm, negative integer. |
| `status_flags` | Always an array, never null. Empty means all sensor reads succeeded. A set flag means that value is the *previous* sample, not a fresh one. |
| `reset_reason_name` | Unknown codes arrive as `unknown_<code>`. Don't treat it as a closed enum. |
| `timestamp` | Unix seconds, one per reading. |
| `timedif` | Raw wire value. Do not use it to compute times, use `timestamp`. |

Two practical consequences:

- **Reject unknown shapes loudly, accept unknown values quietly.** The schema has
  `additionalProperties: false`, so a new field means a schema bump. Pin a
  `version` you understand and alert on anything else.
- **Never use truthiness for presence.** `0`, `0.0` and `false` are all real values.

## 3. Go

Use pointers (or a small `Optional` type) for the conditional fields so "absent"
and "zero" stay distinguishable.

```go
type Reading struct {
	Timestamp         uint64   `json:"timestamp"`
	Temperature       float64  `json:"temperature"`
	Humidity          float64  `json:"humidity"`
	CarbonDioxide     uint16   `json:"carbon_dioxide"`
	Methane           uint16   `json:"methane"`
	MethaneRaw        *float64 `json:"methane_raw"`   // %LEL, nil unless has_raw
	MoistureRaw       *uint16  `json:"moisture_raw"`  // nil unless has_raw
	Moisture          float64  `json:"moisture"`
	BatteryVoltage    uint16   `json:"battery_voltage"`
	BatteryPercentage float64  `json:"battery_percentage"`
	EspTemperature    float64  `json:"esp_temperature"`
	Status            uint8    `json:"status"`
	StatusFlags       []string `json:"status_flags"`
}

type Telemetry struct {
	ID              string    `json:"id"`
	Version         string    `json:"version"`
	Readings        []Reading `json:"readings"`
	HasRaw          bool      `json:"has_raw"`
	HasGPS          bool      `json:"has_gps"`
	Latitude        *float64  `json:"latitude"`
	Longitude       *float64  `json:"longitude"`
	HasCell         bool      `json:"has_cell"`
	MCC             *uint16   `json:"mobile_country_code"`
	MNC             *uint16   `json:"mobile_network_code"`
	SignalStrength  int8      `json:"signal_strength"`
	ResetReason     uint8     `json:"reset_reason"`
	ResetReasonName string    `json:"reset_reason_name"`
}

func decode(body []byte) (*Telemetry, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields() // fail on schema drift
	var t Telemetry
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("decode telemetry: %w", err)
	}
	if t.Version != "0" {
		return nil, fmt.Errorf("unsupported version %q", t.Version)
	}
	if len(t.Readings) == 0 {
		return nil, errors.New("no readings")
	}
	if t.HasGPS && (t.Latitude == nil || t.Longitude == nil) {
		return nil, errors.New("has_gps set but coordinates missing")
	}
	return &t, nil
}
```

## 4. Python

```python
import json
from dataclasses import dataclass
from typing import Optional

@dataclass
class Reading:
    timestamp: int
    temperature: float
    humidity: float
    methane: int
    methane_raw: Optional[float]      # %LEL, None unless has_raw
    moisture_raw: Optional[int]
    esp_temperature: float
    status_flags: list[str]
    # ...remaining fields as needed

def parse(body: bytes) -> dict:
    msg = json.loads(body)
    if msg["version"] != "0":
        raise ValueError(f"unsupported version {msg['version']!r}")
    for r in msg["readings"]:
        r.setdefault("methane_raw", None)   # absent -> None, 0 stays 0
        r.setdefault("moisture_raw", None)
    return msg

# Presence checks: use `is not None`, never `if r["methane_raw"]:`
```

For stricter validation, run the message through `jsonschema` against
`schemas/telemetry-data.schema.json` before trusting it.

## 5. Node / TypeScript

```ts
import Ajv2020 from "ajv/dist/2020";
import schema from "./schemas/telemetry-data.schema.json";

const validate = new Ajv2020({ strict: false }).compile(schema);

export function parse(body: Buffer) {
  const msg = JSON.parse(body.toString("utf8"));
  if (!validate(msg)) throw new Error(JSON.stringify(validate.errors));
  return msg;
}

// Presence: `r.methane_raw !== undefined`, never `if (r.methane_raw)`.
```

## 6. Handling a message safely

1. **Parse and validate first, ack second.** Only `ack` once the message is
   stored. On a malformed body, send it to a dead-letter queue instead of
   requeueing, or one bad message will loop forever.
2. **Make writes idempotent.** RabbitMQ can redeliver. Key rows on
   `(id, timestamp)` and upsert.
3. **Store flagged readings, but mark them.** When `status_flags` is non-empty,
   keep the row and carry the flags, so charts can grey out stale values
   instead of drawing a flat line that looks real.
4. **Don't trust ordering across messages.** A device may upload a backlog
   after an outage, so a later message can hold older timestamps.
5. **Use `id` as the device key**, formatted `XXX-XXX-XXXX`. The routing key
   also contains it, so you can filter before parsing.
6. **Treat numbers as the types shown.** Scaled values (temperature, humidity,
   moisture, battery %) are already divided down to real units, so don't
   divide again.

## 7. Quick checklist

- [ ] Optional fields modelled as optional, checked by presence
- [ ] `version` pinned and unknown versions rejected
- [ ] Schema validation on the consumer, or `DisallowUnknownFields`
- [ ] Bad messages dead-lettered, not requeued
- [ ] Inserts idempotent on `(id, timestamp)`
- [ ] `status_flags` stored alongside each reading
