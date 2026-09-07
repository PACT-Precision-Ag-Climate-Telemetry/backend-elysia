# Elysia with Bun runtime

## Getting Started
To get started with this template, simply paste this command into your terminal:
```bash
bun create elysia ./elysia-example
```

## Development
To start the development server run:
```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.

## Telemetry ingestion consumer

The service consumes parsed telemetry from RabbitMQ. It is a **consumer only** — the only
thing it ever publishes is structured error records. See [src/utils/rabbitmq.ts](src/utils/rabbitmq.ts).

### Topology

Declared on startup over a single connection and channel, in this order:

1. `error_handler_queue` (durable)
2. `failed_messages_queue` (durable)
3. the main ingest queue (durable, `deadLetterExchange: ""`, `deadLetterRoutingKey: failed_messages_queue`)
4. the topic exchange `pact.telemetry` (durable)
5. one binding per routing key, then `prefetch`, then `consume` in manual-ack mode

Every malformed or failed message is `basic.reject(requeue=false)`ed — the empty-string dead
letter exchange sends it through the default exchange straight to `failed_messages_queue` — and a
matching error record is published to `error_handler_queue`. Messages are never requeued.

Messages that are themselves ingest-error records are acked and dropped, so an error record
routed back into the ingest queue cannot loop.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `RABBITMQ_URL` | yes | startup fails without it |
| `RABBITMQ_QUEUE` | no | main ingest queue |
| `INGESTION_QUEUE` | no | legacy fallback for `RABBITMQ_QUEUE` |
| `TELEMETRY_EXCHANGE` | no | topic exchange, default `pact.telemetry` |
| `INGESTION_ROUTING_KEYS` | no | comma-separated binding keys, default `pact.telemetry.#` |
| `INGESTION_EXCHANGES` | no | legacy, declared but unused |

Resolution order per value is: explicit option → environment variable(s) in order → default.
Env values are trimmed, and a value wrapped in matching-length quotes has them stripped.

> **Quote `INGESTION_ROUTING_KEYS`.** `#` starts a comment in `.env`, so
> `INGESTION_ROUTING_KEYS=pact.telemetry.#` silently resolves to `pact.telemetry.`, which binds a
> pattern that matches nothing. Write `INGESTION_ROUTING_KEYS="pact.telemetry.#"`.

Routing keys are `pact.telemetry.{version-major}.{device-id}`, so useful bindings are
`pact.telemetry.#` (everything), `pact.telemetry.*.*` (all telemetry, exactly two segments),
`pact.telemetry.2.*` (major version 2), `pact.telemetry.*.ABC-DEF-1234` (one device).

### Least-privilege broker permissions

- **Configure**: `pact.telemetry`, the main queue, `failed_messages_queue`, `error_handler_queue`
- **Write**: the main queue (bind target), the default exchange `""` (error publish)
- **Read**: `pact.telemetry` (bind source), the main queue (consume + ack/reject)

```bash
rabbitmqctl set_permissions -p / <user> \
  "^pact\.telemetry$|^<queue>$|^failed_messages_queue$|^error_handler_queue$" \
  "^<queue>$|^amq\.default$|^$" \
  "^pact\.telemetry$|^<queue>$"
```

### Tests

```bash
bun test
```

[src/utils/rabbitmq.test.ts](src/utils/rabbitmq.test.ts) drives the consumer against an in-memory
fake broker and covers the topology order, every reject path, the loop guard, config resolution
and the routing-key builder.

### Known gaps

Deliberately not implemented, matching the reference behavior:

- **No reconnection.** There are no `error`/`close` handlers; if the broker drops the connection
  the consumer stops silently while the HTTP server keeps serving.
- **No requeue for transient failures.** A database outage dead-letters real telemetry
  permanently — no retry, delay queue, or redelivery counter.
- **Unbounded in-flight work.** The consume callback is async and not awaited by the client; only
  `prefetch` limits concurrency.
- **A single shared channel** for consuming and error-publishing; a channel-level error kills both.

## Temporary telemetry query endpoint

> **Temporary.** Guarded by a single static token rather than a session, so it does **no**
> organization scoping — any holder of the token can read any device. Remove it, or move it
> behind better-auth with the org hierarchy checks in [src/modules/org](src/modules/org), once
> the dashboard can query telemetry through an authenticated session.
> See [src/modules/telemetry](src/modules/telemetry).

```
GET /telemetry/devices/:deviceId
Authorization: Bearer <TELEMETRY_API_TOKEN>
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEMETRY_API_TOKEN` | yes | shared secret; unset means every request gets `503` |

### Query parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `from` | none | ISO 8601 datetime, inclusive lower bound on `created_at` |
| `to` | none | ISO 8601 datetime, inclusive upper bound on `created_at` |
| `limit` | `100` | 1-1000 |
| `offset` | `0` | |
| `order` | `desc` | `asc` or `desc` by `created_at`, with `id` as tiebreaker |

### Responses

`200` returns `{ device, limit, offset, order, count, readings }`. `device` is the full `device`
row — `id`, `modelName`, `latitude`, `longitude`, `mcc`, `mnc`, `organizationId`, `createdAt`,
`updatedAt` — every field but `id` and `modelName` nullable, since ingestion creates a device with
nulls the first time it sees one. Each reading is a `telemetry_v0` row. All timestamps are ISO 8601
strings.

`device.organization` resolves `organizationId` into the owning organization, and is `null` for a
device ingestion has not yet claimed. Alongside the organization's own columns it carries:

| Field | Notes |
| --- | --- |
| `level` | index into `orgHierarchy`: `root` 0, `government` 1, `province` 2, `municipality` 3, `field` 4. `null` if `org_type` falls outside that set |
| `path` | the ancestor chain built by following `parent_org_id`, root first, the owning organization last — so `path` is the device's full place in the hierarchy |

The walk is capped at the five tiers in [orgHierarchy](src/utils/auth/permission.ts) and skips
repeats, so malformed data with a parent cycle terminates instead of looping. It costs one query
per tier; the endpoint is read-only and low traffic, so it is not batched.

Other codes: `400` (`from` after `to`),
`401` (missing/invalid token), `404` (unknown device), `422` (query parameter validation),
`503` (`TELEMETRY_API_TOKEN` not configured).

```bash
curl -H "Authorization: Bearer $TELEMETRY_API_TOKEN" \
  "http://localhost:3000/telemetry/devices/ABC-DEF-1234?limit=50&order=desc"
```

## Farm fields (PostGIS)

A farm field is an area drawn on the map, owned by an organization. The boundary lives in
`farm_field.area` as a PostGIS `geometry(Polygon,4326)` — SRID 4326 is WGS 84, the same frame GPS
and GeoJSON use.

| Column | Notes |
| --- | --- |
| `id` | cuid2 |
| `name` | field name |
| `organization_id` | the owner; cascades on organization delete |
| `area` | `geometry(Polygon,4326)`, GiST indexed |
| `created_at` / `updated_at` | `updated_at` refreshes via drizzle's `$onUpdate` |
| `deleted_at` | soft delete — `null` means live |

Devices point at their field through `device.farm_field_id`, so "the devices in a field" is
`where farm_field_id = ...`. It is nullable (a device is unassigned until placed) and `ON DELETE SET
NULL`, so hard-deleting a field never cascades into devices and their telemetry history.

### Requirements

The migration begins with `CREATE EXTENSION IF NOT EXISTS postgis;`. That statement needs a
superuser or an `rds_superuser`-equivalent role, and the PostGIS binaries must be installed on the
server — a stock `postgres:17` image does **not** have them; use `postgis/postgis` or install
`postgresql-17-postgis-3`. Without the extension the `geometry` type does not exist and the whole
migration fails.

### Reading and writing the geometry

PostGIS speaks EWKB on the wire, so selecting `area` directly returns an opaque hex string and
inserting GeoJSON fails outright. Everything goes through [src/utils/geo.ts](src/utils/geo.ts):

```ts
import { fromGeometry, toGeometry, parseGeoJsonPolygon, isValidPolygon } from "@/utils/geo";

// write — the polygon is bound as a parameter, not interpolated
await db.insert(farmField).values({ name, organizationId, area: toGeometry(polygon) });

// read — ST_AsGeoJSON returns text, so it still needs parsing
const [row] = await db
  .select({ id: farmField.id, area: fromGeometry(farmField.area) })
  .from(farmField)
  .where(and(eq(farmField.id, id), isNull(farmField.deletedAt)));
const area = parseGeoJsonPolygon(row.area);
```

Validate with `isValidPolygon` before writing: PostGIS raises a runtime error on an unclosed ring,
which would otherwise surface as a 500 instead of a 400.

Every read must filter `isNull(farmField.deletedAt)` — the soft delete is a convention, not a
constraint, so nothing in the database enforces it for you.

## Organization territories and spatial hierarchy

Being a lower tier does not put an organization under a higher one. A `field` is under a
`municipality` only when **its area falls inside that municipality's area**. Tier ordering says
which organizations *may* be a parent; geography says which one *is*.

Each organization carries its own boundary:

| Column | Notes |
| --- | --- |
| `area` | `geometry(MultiPolygon,4326)`, GiST indexed, null until assigned |
| `area_source` | `reference` (fixed administrative GeoJSON) or `custom` (hand drawn) |

MultiPolygon rather than Polygon because a territory can be disjoint — an enclave, an island, a
district split by a river — and because joining several administrative features can leave gaps.

### Who may draw what

Only a `field` organization may submit a `custom` boundary. Every higher tier traces fixed
administrative GeoJSON. Several features can be joined into one territory: `toAreaGeometry([a, b])`
runs `ST_UnaryUnion` over them, dissolving shared borders into a single outline, then `ST_Multi`
normalizes the result. A province defined as "these four districts" is therefore one area to test
against, exactly like a hand-drawn one — the only difference is provenance, recorded in
`area_source` and enforced by `isAreaSourceAllowed`.

### Resolving the parent

[src/modules/org/spatial.ts](src/modules/org/spatial.ts):

```ts
// Every territory that contains this area, tightest fit first
const candidates = await findContainingOrganizations(area, { belowOrgType: "field" });

// Just the immediate parent: the smallest containing territory a tier or more up
const parent = await resolveParentOrganization(area, "field");

// Does a proposed parent actually contain it?
const { contained, coverage, reason } = await checkParentContainsArea(parentOrgId, area);
```

`findContainingOrganizations` restricts candidates to tiers strictly above the child's, prefilters
with `ST_Intersects` so the GiST index does the work, then tests containment exactly. Results are
ordered by coverage descending, then area ascending — so the immediate parent comes first and a
grandparent that also contains the area sorts after it. An area inside no mapped territory returns
no candidates, which is a valid answer, not an error.

Full containment is tested with `ST_CoveredBy` rather than by comparing computed areas: it is a
topological predicate, so it is exact and needs no intersection geometry. Lowering `minCoverage`
switches to the area ratio, for the case where a boundary straddles two parents:

```ts
// Report anything at least 60% inside, so a straddling field is visible
await findContainingOrganizations(area, { belowOrgType: "field", minCoverage: 0.6 });
```

Coverage is computed with `::geography` casts, so the ratio is of true surface areas — comparing
raw degrees distorts badly away from the equator.

### Creation

`POST /org/create` accepts an optional `area` — one GeoJSON Polygon/MultiPolygon, or an array of
them to be joined — plus an optional `areaSource`, defaulting to `custom` for a field and
`reference` for every higher tier.

**When an area is supplied, geography decides the parent and any `parentOrgId` in the body is
ignored.** Resolution runs in two stages:

1. the smallest territory that wholly contains the area (`parentResolution: "contained"`);
2. failing that, the territory holding the largest share of a straddling boundary, provided that
   share is at least `MAJORITY_COVERAGE` (60%) — `parentResolution: "majority"`;
3. otherwise no parent (`"none"`), which a non-field organization rejects with a 400.

The response echoes `areaSource` and `parentResolution`, so a caller can tell a clean containment
from a straddle that was resolved by majority.

Creating a non-field organization still requires `owner` or `admin` in the parent — now checked
against the *resolved* parent. A field organization is attached to whatever territory it falls in
without needing membership there, which is the point: a field physically inside a municipality
belongs to it.

New 400s: `Only a field organization may draw a custom area`, `Organization area is not valid
GeoJSON`, `Could not resolve a parent organization from the given area`.
