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

[`POST /v1/org`](#post-v1org) accepts an optional `area` — one GeoJSON Polygon/MultiPolygon, or an
array of them to be joined — plus an optional `areaSource`, defaulting to `custom` for a field and
`reference` for every higher tier.

**When an area is supplied, geography decides the parent and any `parentOrgId` in the body is
ignored.** Resolution runs in two stages:

1. the smallest territory that wholly contains the area (`parentResolution: "contained"`);
2. failing that, the territory holding the largest share of a straddling boundary, provided that
   share is at least `MAJORITY_COVERAGE` (60%) — `parentResolution: "majority"`;
3. otherwise no parent (`"none"`), which a non-field organization rejects with a 400.

The response echoes `areaSource` and `parentResolution`, so a caller can tell a clean containment
from a straddle that was resolved by majority.

Creating a non-field organization requires `owner` or `admin` in the *resolved* parent. A field
organization is attached to whatever territory it falls in without needing membership there, which
is the point: a field physically inside a municipality belongs to it.

Related error codes: `custom_area_not_allowed`, `invalid_area`, `parent_unresolvable`.

## Device visibility

Who may see a device depends on the tier:

| Level | Org types | Rule |
| --- | --- | --- |
| 0-3 | `root`, `government`, `province`, `municipality` | sees **any device standing inside its territory**, owned or not |
| 4 | `field` | sees **only the devices it owns** |

[src/utils/auth/device-visibility.ts](src/utils/auth/device-visibility.ts):

```ts
const { visible, reason, organizationId } = await canUserViewDevice(userId, deviceId);
const ids = await listVisibleDeviceIds(userId);
const check = await canOrganizationViewDevice(orgId, deviceId);
```

`reason` is `owner`, `area` or `none`. Ownership is reported ahead of territory when both apply, so
the answer names the strongest claim rather than whichever row the planner returned first.

The line sits at `AREA_VISIBILITY_MAX_LEVEL` (3). Add a sixth tier beneath `field` and raise the
constant if that new tier becomes the ownership-only one — the two helpers derive their org-type
lists from `orgHierarchy`, so nothing else needs touching.

### How position is tested

A device carries `latitude`/`longitude` as plain columns, not a geometry, so its position is built
per query as `ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)` and tested with
`ST_Covers(organization.area, point)` — `Covers` rather than `Contains`, so a device sitting exactly
on a boundary counts as inside rather than nowhere.

Two consequences worth knowing:

- **A device with no GPS fix is invisible by area.** Ingestion writes `latitude`/`longitude` as null
  until a device reports a position, so until then only its owner sees it.
- **The point is computed, so no spatial index applies to it.** The GiST index on
  `organization.area` still helps, but a device-heavy deployment will want a generated geometry
  column on `device` with its own index.

Ownership means `device.organization_id`, which ingestion leaves null — a device is invisible to
everyone at level 4 until it is claimed.

## v1 API

Versioned endpoints live under `/v1`. The unversioned routes stay as they are; nothing about them
changed.

### `POST /v1/org`

Creates an organization for the signed-in user, following the hierarchy rules.
[src/modules/org/v1.ts](src/modules/org/v1.ts)

**Slug, by tier:**

| Tier | Slug |
| --- | --- |
| `field` (level 4) | assigned at random; any `slug` in the request is **ignored** |
| levels 0-3 | **required**, and must be unique |

A field organization names someone's own plot, so it has no reason to pick a public identifier.
Every tier above names an administrative body, where the identifier is the point.

Supplied slugs must be lowercase letters, digits and single hyphens between them (3-64 chars) —
the same shape the generator produces. Generation is bounded at 10 attempts and fails loudly rather
than looping forever once the dictionary space fills up.

**Body:**

| Field | Notes |
| --- | --- |
| `orgName` | required, min 5 characters |
| `orgType` | one of the five tiers, defaults to `field` |
| `slug` | required above level 4, ignored at level 4 |
| `parentOrgId` | required above level 4 unless `area` resolves one; ignored when `area` is given |
| `area` | optional GeoJSON, or an array to join; resolves the parent by geography |
| `areaSource` | `custom` (field only) or `reference`; defaults by tier |
| `logo` | optional |

**Responses:** `201` returns the organization plus `slugSource` (`generated` \| `provided`),
`parentResolution` and `areaSource`, so a client can see how each was decided.

Errors carry a machine-readable code alongside the message, rather than making clients match on
text:

```json
{ "code": "slug_required", "message": "slug is required for this organization type" }
```

| Code | Status |
| --- | --- |
| `unauthorized` | 401 |
| `slug_required`, `slug_taken` | 400 |
| `parent_required`, `parent_not_found`, `parent_unresolvable` | 400 |
| `hierarchy_violation`, `invalid_area`, `custom_area_not_allowed` | 400 |
| `root_not_allowed`, `insufficient_permission` | 403 |
| `org_not_found` | 404 |
| `slug_not_editable`, `org_not_deleted` | 400 |
| `slug_generation_failed` | 500 |

**Who may create what.** A `field` needs no parent and no existing membership, which is what lets a
brand new user create one. Every higher tier requires `owner` or `admin` in the parent. `root`
cannot be created here at all — it has no tier above it, so there is nothing to authorize against;
seed it out of band.

### `PATCH /v1/org/:orgId`

Edits an organization. Requires the `edit` permission, resolved through
[checkOrgHierarchyPermission](src/utils/auth/hierarchy.ts) — `myOrg` scope for your own
organization, `subOrg` for one below you in the hierarchy.

Send only what changes; an empty body is rejected rather than issuing a no-op update. `orgName`,
`slug`, `logo`, `area` and `areaSource` are all optional, and `logo: null` clears it.

- **A field organization cannot change its slug** (`slug_not_editable`) — it was assigned one at
  random on creation, so it is not the caller's to pick.
- **Changing `area` re-resolves the parent**, because moving a boundary can move the organization
  into a different territory. The response reports the new `parentResolution`.

The response lists `updatedFields`, so a caller can see exactly what the request changed.

### `DELETE /v1/org/:orgId`

Requires the `delete` permission. **This is a soft delete**: it sets `deleted_at` and nothing else.

A hard delete would cascade `organization → device → telemetry_v0` and destroy the entire reading
history of every device the organization owns, which is not a reasonable outcome of pressing a
delete button.

**Retiring a middle organization promotes its children rather than orphaning them.** Each live child
takes on the deleted organization's own parent — a field under a deleted municipality moves up to
the province. Tier ordering still holds, since a grandparent sits above the parent that just left.
A deleted top-level organization leaves its children top level, with a null parent.

The response reports `promotedTo` and the `reparented` list, so the caller sees exactly what moved.

### `POST /v1/org/:orgId/restore`

Brings a soft-deleted organization back and **recomputes the hierarchy from geography**, which is
what puts the promoted children back where they belong:

1. the restored organization's own parent is re-resolved from its area;
2. every live organization at a tier below it whose territory falls inside its own is re-resolved
   too — found by inverting the containment test (`ST_CoveredBy(child.area, restored.area)`).

Children promoted away on delete fall back under it automatically, because it is once again the
smallest territory that contains them. No record of the old structure is kept; the boundaries are
the source of truth, so the tree is rebuilt from them rather than replayed from a log.

Requires the `delete` permission — the one that retired it. Because the target is deleted, the
permission check is called with `includeDeleted`, which it otherwise refuses.

Recomputation is deliberately conservative: an organization with **no** boundary is skipped
entirely, and one whose area resolves to no parent keeps the parent it has. Parentage set by hand
is never nulled out by a geography that cannot speak to it.

Restoring a live organization returns `400 org_not_deleted`.

Every query that grants access or resolves structure now filters `deleted_at IS NULL`: containment
and parent resolution in [spatial.ts](src/modules/org/spatial.ts), device visibility in
[device-visibility.ts](src/utils/auth/device-visibility.ts), and the permission walk in
[hierarchy.ts](src/utils/auth/hierarchy.ts). A soft-deleted organization therefore grants no
visibility, adopts no children and is never resolved as a parent.

### Permission matrix

`edit` and `delete` come straight from `rolePermissions`:

| Role | Edit own | Delete own | Edit below | Delete below |
| --- | --- | --- | --- | --- |
| `owner` | yes | yes | yes | yes |
| `admin` | yes | **no** | yes | yes |
| `member` | no | no | no | no |

An admin can edit its own organization but not delete it, while it can do both to one below —
that asymmetry is the existing model, not something these endpoints add.

## v1 device and telemetry queries

The session-authenticated way to read devices and their readings, scoped by the organization rules
rather than by a shared secret. [src/modules/device/v1.ts](src/modules/device/v1.ts)

| Endpoint | Returns |
| --- | --- |
| `GET /v1/device` | a page of the devices the caller can see |
| `GET /v1/device/:deviceId` | one device, plus which organization made it visible |
| `GET /v1/device/:deviceId/telemetry` | that device's readings |

Visibility is the rule from [device visibility](#device-visibility): levels 0-3 see any device
standing inside their territory, level 4 sees only what it owns. Every response carries a
`visibility` field of `owner` or `area`, so a client can tell a device it controls from one it is
merely overseeing.

### Query parameters

`GET /v1/device` takes `limit` (1-200, default 50) and `offset`.

`GET /v1/device/:deviceId/telemetry` takes the same `from`, `to`, `limit` (1-1000, default 100),
`offset` and `order` as the temporary bearer endpoint.

### A device you cannot see is a 404

Not a 403. Answering "it exists, but is not yours" would leak the presence and id of devices in
territories the caller has no claim on. The visibility check also runs *before* the device is
confirmed to exist, so a device outside your scope and one that was never provisioned are
indistinguishable from the outside.

Errors carry a code, as elsewhere in v1: `unauthorized` (401), `device_not_found` (404),
`invalid_range` (400, `from` after `to`).

### Relationship to the temporary endpoint

`GET /telemetry/devices/:deviceId` still exists and still takes `TELEMETRY_API_TOKEN`. It performs
**no** organization scoping, so it remains the thing to remove once clients have moved to
`/v1/device/:deviceId/telemetry`.

The two differ in shape: the temporary endpoint embeds the full device and its organization path in
every response, while the v1 telemetry route returns readings and expects the client to fetch the
device separately from `GET /v1/device/:deviceId` — one round trip more, but it does not re-send a
five-level organization chain alongside every page of readings.

## Organization logo upload

`POST /v1/org/:orgId/logo` — `multipart/form-data` with a `file` field. `DELETE /v1/org/:orgId/logo`
removes it. Both require the `edit` permission, same as `PATCH /v1/org/:orgId`.

The upload is **proxied through the API** rather than presigned. A presigned PUT hands the client a
URL and then accepts whatever it sends; going through the API is what makes the checks below
possible at all. Logos are small and written rarely, so the bandwidth through the app is not worth
the two-step dance, the CORS configuration and the orphaned objects that direct-to-storage brings.

### What happens to an uploaded file

1. **Size cap** — refused at 2 MB, checked against `file.size` before the bytes are read into memory.
2. **Magic-byte sniffing** — the format is decided by the leading bytes, never the declared
   `Content-Type`, which is attacker-controlled. PNG, JPEG, WebP and GIF are accepted.
3. **SVG is refused outright** (`415 svg_not_allowed`). It is XML, it can carry `<script>`, and it
   would be served as an active document. This check cannot be delegated: **sharp rasterizes SVG
   happily**, script tag and all, so the refusal has to happen before the bytes reach it.
4. **Re-encoded to WebP** at quality 82, scaled to fit 512px on the longest edge, never enlarged.
5. **EXIF is stripped** as a consequence of re-encoding — sharp only carries metadata across when
   asked, so GPS coordinates and camera details are dropped. `rotate()` runs first, so an image
   whose EXIF said "rotate 90" keeps its intended orientation once the tag is gone.
6. **Decode is bounded** at 50 megapixels, because a few kilobytes of PNG can expand into gigapixels
   of memory regardless of the file-size cap.

Animated GIF and WebP collapse to their first frame: a logo does not need to move.

### Storage layout

The object key is `org/{orgId}/logo/{sha256-prefix}.webp` — content-addressed, so re-uploading the
same image dedupes and the URL can be cached indefinitely. Client filenames are never used.

`organization.logo` holds **the key**, not a URL, and the public URL is composed at read time from
`S3_PUBLIC_BASE_URL`. Storing absolute URLs would turn a change of CDN domain into a migration over
every row. Values that are already absolute URLs are passed through unchanged, so anything stored
before uploads existed still resolves.

Replacing a logo deletes the previous object, best effort. Removing one clears the column and
deletes the object. Neither is done for an absolute URL, which is not ours to delete.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `S3_ENDPOINT` | yes | e.g. `http://garage.internal:3900` |
| `S3_BUCKET` | yes | |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | |
| `S3_REGION` | no | defaults to `garage`; ignored by Garage but the SigV4 signer needs a value |
| `S3_PUBLIC_BASE_URL` | no | where the bucket is served publicly; without it, `url` comes back null |

With any of the first four missing, upload returns `503 storage_not_configured` rather than failing
obscurely. Uses Bun's built-in `S3Client`, so there is no AWS SDK in the dependency tree, and
path-style addressing (`virtualHostedStyle: false`) because virtual-hosted style needs wildcard DNS.

Garage grants anonymous read at the **bucket** level rather than per object, so make the logo bucket
world-readable once and rely on the unguessable content-addressed keys — do not expect a
per-object `public-read` ACL to work.

> **Serve logos from a different hostname than the API.** The bucket holds user-supplied bytes; a
> host that shares cookies with the app is a host where a bad file becomes a session problem.

### Error codes

`storage_not_configured` (503), `image_too_large` (413), `svg_not_allowed` and
`unsupported_image_type` (415), `image_invalid` (400), `storage_unavailable` (502),
`org_not_found` (404), `insufficient_permission` (403), `unauthorized` (401).
