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
strings. Other codes: `400` (`from` after `to`),
`401` (missing/invalid token), `404` (unknown device), `422` (query parameter validation),
`503` (`TELEMETRY_API_TOKEN` not configured).

```bash
curl -H "Authorization: Bearer $TELEMETRY_API_TOKEN" \
  "http://localhost:3000/telemetry/devices/ABC-DEF-1234?limit=50&order=desc"
```
