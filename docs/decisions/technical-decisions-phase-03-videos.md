---
scope_type: phase
related_phases: [3]
status: Finalized
date: 2026-07-08
scope_description: "Backend + storage foundation for video upload and processing: message queue technology, 10GB direct-to-storage upload, object storage layout, upload-completion trigger, dedicated video worker with FFmpeg/ffprobe, unique video URL identifier, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers upload orchestration (draft pre-registration, presigned URL issuance, completion callback), the background job queue, the dedicated video worker (FFmpeg/ffprobe: duration/metadata extraction + thumbnail generation), unique-URL generation, and streaming/download URL delivery. Owns the `videos` entity/table linked to `channels`.
- `next-frontend/` — participates only through the **Cross-layer** TDs below: it drives the direct-to-storage upload handshake (TD-02), signals upload completion (TD-04), consumes the unique video URL (TD-07), and requests streaming/download URLs (TD-08). No frontend-only open decision exists in this phase — the video **player** and the visualization page belong to Fase 05; here the frontend only exercises the contracts these TDs define.
- **Infra / Docker Compose** — object storage (MinIO, S3-compatible) is added as a Compose service, and the queue TD (TD-01) may add a second infra service (Redis). Both are dev-local containers swapped for managed services (S3, managed Redis) in production. Storage backend itself is **not** an open decision (project already targets S3-compatible storage); only its usage is decided here (TD-03).

---

## TD-01: Message Queue / Background Job Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan lists the Message Queue as **TBD** — this is the headline stack decision of the phase. Video processing (metadata extraction + thumbnail generation) is heavy and must run out-of-band from the request cycle. The queue choice determines what infrastructure the worker needs, how retries/backoff/concurrency are expressed, and whether a new datastore joins the stack. PostgreSQL is already present; Redis is not.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue, the de-facto standard for Node.js background jobs. Official NestJS module (`@nestjs/bullmq`) provides `@Processor`/`@Process` DI decorators, `Queue` injection, and lifecycle events. First-class retries with exponential backoff, per-queue concurrency, rate limiting, delayed/repeatable jobs, and a mature dashboard ecosystem (Bull Board).
- **Pros:** Best-in-class support for long-running, resource-heavy jobs (exactly the video-processing profile). Native concurrency control caps how many FFmpeg jobs run at once. Robust, atomic job state and reliable retry/backoff. Excellent NestJS integration and observability tooling.
- **Cons:** Adds **Redis** as a new infrastructure dependency (one more Compose service in dev, one more managed service in prod). Job payload lives in Redis (in-memory) — needs persistence config for durability. New operational surface to learn/monitor.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue implemented entirely on top of the existing PostgreSQL instance using `SKIP LOCKED`. No new datastore. Supports retries, backoff, scheduling, and dead-letter queues via SQL tables.
- **Pros:** **Zero new infrastructure** — reuses the PostgreSQL already in the stack, aligning with the plan's "plan storage growth and costs from the start" concern. Jobs are durably persisted (survive restarts) by default. Transactional enqueue is possible in the same DB as the `videos` row (no dual-write inconsistency). Simple ops footprint.
- **Cons:** No official NestJS module — requires a thin custom provider/wrapper. Lower throughput ceiling than Redis under high job volume (not a concern at this scale). Fewer batteries-included features and a smaller dashboard ecosystem. Long-running jobs need careful visibility-timeout tuning.

### Option C: Managed cloud queue (AWS SQS + a Node consumer)
- Offload queuing to a managed service (SQS) consumed by the worker via the AWS SDK.
- **Pros:** Fully managed, effectively infinite scale, no queue infra to run. Natural fit if the platform later runs on AWS with S3.
- **Cons:** No local dev parity without emulation (LocalStack) — contradicts the Docker-first "same everywhere" principle already established. Vendor lock-in this early. At-least-once delivery + visibility timeouts push idempotency complexity onto the worker. Overkill for a single-instance MBA-scoped project.

**Recommendation:** **Option A (BullMQ + Redis)** — video processing is precisely the long-running, concurrency-sensitive workload BullMQ is built for; native concurrency limits and exponential-backoff retries directly serve TD-09's failure handling, and the official `@nestjs/bullmq` module keeps the worker inside the same DI/testing conventions as the rest of the backend. The cost is one Redis container in Compose — a low, well-understood addition. If the team prioritizes infra-minimalism over throughput/tooling, **Option B (pg-boss)** is the honest runner-up: it adds nothing to the stack and gives transactional enqueue with the `videos` row, at the price of a hand-rolled NestJS integration.

**Decision:** Option A (Redis)

---

## TD-02: Large-File Upload Strategy (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must never stream through the NestJS API — passing multi-gigabyte bodies through the app would exhaust memory/connections and block the event loop, violating "sem impacto na performance". The bytes must go **directly from the browser to object storage**. The chosen protocol is a contract exercised on both sides: the backend issues credentials/URLs and the frontend orchestrates the transfer.

**Options:**

### Option A: S3 Presigned Multipart Upload (direct browser → storage)
- Backend calls `CreateMultipartUpload`, then issues a **presigned `UploadPart` URL per chunk** (parts ≥ 5MB except the last) via `@aws-sdk/s3-request-presigner`. The browser `PUT`s parts directly to MinIO/S3 (in parallel, retryable per part), then the backend finalizes with `CompleteMultipartUpload`. The API never touches the video bytes.
- **Pros:** Bytes bypass the API entirely — no memory/connection pressure. Per-part granularity gives **resumability** and parallelism (retry only the failed 5MB part, not 10GB). Native S3/MinIO feature — same API in dev and prod. Storage handles integrity (per-part ETags).
- **Cons:** Multi-step handshake (init → N part URLs → complete) on both client and server. Client must chunk the file and track part numbers/ETags. Orphaned multipart uploads need a lifecycle/abort cleanup policy.

### Option B: Single presigned PUT (direct browser → storage, one URL)
- Backend issues one presigned `PutObject` URL; the browser uploads the whole file in a single `PUT`.
- **Pros:** Simplest handshake — one URL, one request. Still bypasses the API.
- **Cons:** **No resumability** — a dropped connection at 9GB restarts from zero, unacceptable for 10GB over real networks (the plan explicitly calls for resumable upload in "Pontos de Atenção"). S3 single-`PutObject` limit is 5GB, below the 10GB requirement. No parallelism.

### Option C: tus resumable protocol (`tus-node-server` + `tus-js-client`)
- Adopt the tus open protocol for resumable uploads; a tus server endpoint receives chunks and persists to storage.
- **Pros:** Purpose-built resumable protocol with mature clients; automatic resume across sessions.
- **Cons:** The tus endpoint typically **proxies bytes through the app tier** (re-introducing the load TD-02 exists to avoid) unless paired with an S3 store add-on that re-implements multipart anyway. New protocol + dependency to operate. Redundant with S3's native multipart, which MinIO/S3 already provide for free.

**Recommendation:** **Option A (S3 Presigned Multipart)** — it is the only option that simultaneously satisfies the 10GB ceiling (single-PUT caps at 5GB), keeps all bytes off the API tier, and delivers resumability/parallelism via native S3/MinIO features with no extra protocol server. Depends on TD-03 (key layout) for where parts land and TD-04 for how completion is confirmed.

**Decision:** Option A (S3 Presigned Multipart)

**Revisions:**
- 2026-07-09 — Confirmed during phase-plan validation: multipart part size fixed at 50MiB (within the "≥5MB except the last" constraint) and presigned `UploadPart` URL expiry set to 12h. Rationale: 50MiB parts keep the part count manageable for a 10GB file (~200 parts) while staying well above the 5MB floor; a 12h expiry gives slow or interrupted uploads a generous window to complete without re-issuing URLs.

---

## TD-03: Object Storage Layout & Access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is MinIO (S3-compatible) in dev, S3 in prod — not an open choice. What must be decided is **how** to organize buckets and object keys and how the backend accesses them, since these keys are persisted on the `videos` row and referenced by upload (TD-02) and delivery (TD-08).

**Options:**

### Option A: Single bucket, prefixed keys (`videos/{channelId}/{videoId}/original.mp4`, `thumbnails/{channelId}/{videoId}/thumb.jpg`)
- One bucket (e.g. `streamtube-media`) with role-based prefixes; access mediated by presigned URLs. Store the flat object keys on the `videos` row.
- **Pros:** Simplest to provision (one bucket in dev and prod). Prefixes give logical separation and easy per-channel/per-video listing and cleanup. Lifecycle rules can target prefixes. Deterministic keys from `channelId`/`videoId`.
- **Cons:** Original videos and public thumbnails share one bucket, so per-asset-type policy (e.g. public-read thumbnails vs fully-private originals) must be expressed per-prefix rather than per-bucket.

### Option B: Separate buckets per asset type (`streamtube-videos`, `streamtube-thumbnails`)
- Distinct buckets for originals and thumbnails.
- **Pros:** Bucket-level policy separation (e.g. thumbnails bucket could be public-read, videos bucket strictly private). Independent lifecycle/cost tracking per asset class.
- **Cons:** More buckets to provision and configure consistently across dev/prod. Cross-asset operations for one video span two buckets. Marginal benefit while both asset types are served via presigned URLs anyway (TD-08).

### Option C: Bucket per channel
- One bucket created per channel.
- **Pros:** Hard tenant isolation per channel.
- **Cons:** Buckets are a scarce, slow-to-create resource with account-level limits — creating one per channel does not scale and adds provisioning latency to channel creation. Anti-pattern for S3. Rejected.

**Recommendation:** **Option A (single bucket, prefixed keys)** — keeps provisioning trivial (matches the single-instance Docker setup), gives clean per-channel/per-video organization and cleanup, and keeps all objects private with access granted exclusively through presigned URLs (TD-02 for upload, TD-08 for delivery). Persist the object keys (not full URLs) on the `videos` row so the bucket/endpoint stays swappable between MinIO and S3.

**Decision:** Option A (single bucket, prefixed keys)

---

## TD-04: Upload-Completion Trigger → Processing Enqueue

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Because bytes go directly to storage (TD-02), the API does **not** observe the transfer finishing. Yet the plan requires (a) pre-registering the video as a **draft** when upload starts and (b) automatically processing it **after** upload. Something must tell the backend "the object is now fully in storage — enqueue the job." This handshake spans frontend and backend.

**Options:**

### Option A: Client completion callback + server-side verification
- Frontend, after `CompleteMultipartUpload`, calls `POST /videos/:id/complete`. The backend performs a `HeadObject` (confirming the object exists and size matches) then transitions status `uploading → processing` and enqueues the job.
- **Pros:** Deterministic and synchronous with the user action — immediate feedback. `HeadObject` verification guards against a client lying or a partial upload. No dependency on storage event wiring; identical behavior in MinIO and S3. Enqueue happens in the same request that owns the `videos` row.
- **Cons:** Relies on the client to make the call — a client that uploads then crashes leaves a video stuck in `uploading` (mitigated by a reconciliation sweep / TTL that aborts stale multipart uploads).

### Option B: Storage bucket event notification
- Configure the bucket to emit an event on object creation (S3 → SNS/SQS/Lambda, or MinIO webhook/AMQP) that the backend consumes to enqueue the job.
- **Pros:** Fully decoupled from the client — fires even if the browser closes after the storage completes the object. Robust against client drop-off.
- **Cons:** Different wiring for MinIO (webhook/bucket notifications) vs S3 (SNS/SQS/EventBridge) — dev/prod divergence to maintain. Extra infra + eventual-consistency delay. Harder to correlate the raw object key back to the pre-registered `videos` row without encoding IDs in the key.

### Option C: Backend polling
- Backend periodically polls storage (`HeadObject`) for `uploading` videos to detect completion.
- **Pros:** No client dependency, no event wiring.
- **Cons:** Wasteful and laggy; polling interval trades latency against load. Poor UX and unnecessary storage API traffic. Rejected for the common path.

**Recommendation:** **Option A (client callback + `HeadObject` verification)** — deterministic, gives the user immediate status feedback, and works identically on MinIO and S3 with no event-bus wiring. Pair it with a background reconciliation job (using the TD-01 queue's scheduling) that aborts multipart uploads and marks `uploading` videos stale after a TTL, covering the client-drop-off gap that is Option B's only real advantage. Depends on TD-01 (enqueue) and TD-02 (upload flow).

**Decision:** Option A (client callback + `HeadObject` verification)

**Revisions:**
- 2026-07-09 — Completion transition and the stale-upload sweep operate on the `draft` state, not a separate `uploading` state (aligns with TD-09's simplified lifecycle): the verified completion callback moves `draft → processing`, and the reconciliation sweep reclaims videos left in `draft` past the TTL. Stale-upload sweep TTL confirmed at 24h during phase-plan validation. Rationale: the `uploading` state was removed from the lifecycle (see TD-09 revision); the sweep therefore targets stale `draft` rows.

---

## TD-05: Video Worker Runtime

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram already names a separate **Video Worker (FFmpeg)** container. FFmpeg/ffprobe on a 10GB file is CPU- and memory-intensive and long-running. The decision is where the worker code runs relative to the API process.

**Options:**

### Option A: Dedicated worker container (separate process, same codebase)
- A second entrypoint (e.g. `worker.ts` bootstrapping a NestJS application context without the HTTP server) runs the BullMQ processor. Deployed as its own Compose service with FFmpeg installed in its image; shares entities/DB config with the API via the monorepo.
- **Pros:** Matches the documented architecture. CPU-bound FFmpeg work cannot starve the API's event loop or exhaust its memory — the API stays responsive during heavy processing. Independently scalable (run N workers) and independently resource-limited. FFmpeg binary lives only in the worker image, keeping the API image lean.
- **Cons:** Second container/image to build and run. Shared code must be organized so both entrypoints compile (already a monorepo, so low cost).

### Option B: In-process worker (same API container, concurrency-limited)
- The API process also hosts the BullMQ processor with a low concurrency cap.
- **Pros:** One container, simplest deployment. Fine for tiny scale.
- **Cons:** FFmpeg competes with request handling for CPU/memory in the same process/container — directly contradicts "sem impacto na performance". API image must bundle FFmpeg. Cannot scale processing independently of the API. Diverges from the documented architecture.

### Option C: Serverless/on-demand FFmpeg (e.g. Lambda container)
- Each job triggers an ephemeral function running FFmpeg.
- **Pros:** Scales to zero, no idle worker cost.
- **Cons:** 10GB inputs strain function time/space limits; needs cloud emulation for local dev, breaking Docker-first parity. Cold starts and vendor lock-in. Overkill at this scope. Rejected.

**Recommendation:** **Option A (dedicated worker container)** — it is the architecture already committed to in the diagram and the only option that isolates heavy FFmpeg work from API responsiveness while allowing independent scaling and a lean API image. In dev it is one more Compose service consuming the TD-01 queue.

**Decision:** Option A (dedicated worker container)

---

## TD-06: FFmpeg / ffprobe Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Inside the worker (TD-05), duration/metadata come from **ffprobe** and the thumbnail from an **ffmpeg** frame extraction. The decision is how the Node worker invokes these binaries. The worker must stream the source from storage (not download 10GB to local disk where avoidable).

**Options:**

### Option A: Direct `child_process` spawn of `ffmpeg`/`ffprobe`
- Invoke the binaries directly via `spawn`, parsing `ffprobe -show_format -show_streams -print_format json` for metadata and running an `ffmpeg -ss <t> -frames:v 1` command for the thumbnail.
- **Pros:** No third-party wrapper dependency — one less package to track. Full control over exact flags, stdin/stdout streaming, and error/stderr handling. Nothing to break on FFmpeg version changes beyond the CLI contract, which is stable.
- **Cons:** More boilerplate to build and parse commands and to marshal errors/timeouts by hand. Team owns the argument construction and JSON parsing.

### Option B: `fluent-ffmpeg` wrapper
- Use the `fluent-ffmpeg` library's chainable API to build commands and read metadata via `ffprobe()`.
- **Pros:** Ergonomic, readable command building; convenient `.screenshots()` helper for thumbnails and a metadata callback. Widely referenced in tutorials.
- **Cons:** The package is **effectively unmaintained** (long stale release cadence) — a real supply-chain/maintenance risk for a greenfield project. Adds an abstraction over a CLI that is already stable and simple. Still requires the FFmpeg binary present anyway.

**Recommendation:** **Option A (direct `child_process` spawn)** — the ffprobe/ffmpeg CLI surface needed here is small and stable (one metadata probe, one frame grab), so a thin internal helper avoids taking on an unmaintained dependency for marginal ergonomic gain. Wrap the spawn calls in a small typed service with explicit timeouts and stderr capture to feed TD-09's failure handling.

**Decision:** Option A (direct `child_process` spawn)

**Revisions:**
- 2026-07-09 — Confirmed during phase-plan validation: the thumbnail is captured from the frame at 10% of the video duration, and accepted upload formats are unrestricted (any file) with ffprobe as the authoritative validation — a source with no video stream drives a permanent `failed` (TD-09). Rationale: 10% avoids black intro frames while staying representative; deferring format validation to ffprobe removes a brittle client-side allowlist and centralizes the check where the real inspection already happens.

---

## TD-07: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, collision-free public identifier used in its URL (`/watch/{id}` or `/{id}`). The identifier is a contract: the backend generates and persists it; the frontend builds links and routes from it. It must be unguessable-enough, URL-safe, and short. The `videos` PK is a UUID (per entity conventions) but a raw UUID is long and ugly in URLs.

**Options:**

### Option A: `nanoid` short id (dedicated public column)
- Generate an 11–12 char URL-safe id (`nanoid`) stored in a separate `public_id` unique column, distinct from the internal UUID PK.
- **Pros:** Short, clean, YouTube-like URLs. URL-safe alphabet by default. Collision probability negligible at this scale; enforced by a unique constraint with regenerate-on-conflict. Decouples the public identifier from the internal PK (PK stays a UUID per entity rules). Tiny, well-maintained dependency.
- **Cons:** A second identifier column to index and carry. Requires the unique constraint + retry-on-collision guard.

### Option B: UUID v4 as the URL id (reuse the PK)
- Expose the existing UUID PK directly in the URL.
- **Pros:** Zero extra column or dependency — already generated by `@PrimaryGeneratedColumn('uuid')`. Globally unique by construction.
- **Cons:** 36-char URLs — long and unfriendly, unlike the "URL curta e única" the plan calls out in "Pontos de Atenção". Leaks that the id is a UUID.

### Option C: `sqids`/`hashids` over a sequential counter
- Encode a sequential integer into a short opaque string.
- **Pros:** Very short ids; reversible without a lookup column.
- **Cons:** Requires a sequential source (conflicts with the UUID-PK convention). Sequential origin is enumerable/guessable even after encoding (can reveal ordering/volume). More moving parts than nanoid for the same outcome.

**Recommendation:** **Option A (`nanoid` in a dedicated `public_id` column)** — delivers the short, unique, unguessable URL the plan explicitly wants while preserving the UUID-PK entity convention. The unique constraint plus regenerate-on-collision makes conflicts a non-issue. The frontend routes purely on `public_id`.

**Decision:** Option A (`nanoid` in a dedicated `public_id` column)

**Revisions:**
- 2026-07-09 — `public_id` length fixed at 11 characters (nanoid), narrowing the original "11–12" range. Rationale: 11 chars matches the YouTube-style identifier length and keeps collision probability negligible at this scale, backed by the unique constraint + regenerate-on-conflict guard already decided.

---

## TD-08: Streaming & Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`), and the user must also be able to download the original. Both are contracts: the backend decides how bytes reach the browser; the frontend `<video>`/player and download button consume the result. As with upload, streaming 10GB **through** the API tier is undesirable.

**Options:**

### Option A: Presigned GET URL, browser streams directly from storage
- Backend issues a short-lived presigned `GetObject` URL; the browser's `<video>` element (or download) hits storage directly. **MinIO/S3 natively honor `Range` requests and return `206 Partial Content`**, so seeking/streaming works with zero API involvement in the byte path. Download uses the same mechanism with `response-content-disposition=attachment`.
- **Pros:** No video bytes cross the API — same performance guarantee as the upload path. Range/`206` streaming is handled natively by storage. Trivial to add a forced-download variant via response headers. Identical in MinIO and S3.
- **Cons:** URL is time-limited — the player must handle expiry/refresh for very long sessions. Access control happens at URL-issuance time, not per-byte (fine: anonymous viewing is allowed by the plan; unlisted/private rules are enforced when issuing the URL).

### Option B: API range-proxy (`206 Partial Content` through NestJS)
- A controller reads the `Range` header, streams the corresponding byte range from storage through the API, and returns `206`.
- **Pros:** Full control at the app tier — can enforce per-request authorization and hide storage entirely. No presigned-URL expiry for the client to manage.
- **Cons:** Every viewer's bytes flow through the API — reintroduces exactly the load/bandwidth problem the direct-to-storage design avoids, and does not scale for a video platform. Manual Range parsing and stream plumbing. Higher latency and cost.

### Option C: CDN in front of storage
- Serve via a CDN (CloudFront) with signed URLs/cookies.
- **Pros:** Best production performance and cache locality; the natural prod endgame.
- **Cons:** No local dev parity (no CDN in Docker) — cannot be the primary dev mechanism; sits *in front of* Option A rather than replacing it. Defer as a prod optimization layered over presigned GETs.

**Recommendation:** **Option A (presigned GET, direct-from-storage)** — it keeps bytes off the API tier (consistent with TD-02), gets Range/`206` streaming for free from MinIO/S3, and covers download via a `content-disposition` variant of the same presigned URL. Authorization is enforced at issuance (checking visibility rules), which suffices for the anonymous-viewing model. A CDN (Option C) can later wrap this without changing the contract. Depends on TD-03 (object keys).

**Decision:** Option A (presigned GET, direct-from-storage)

**Revisions:**
- 2026-07-09 — Presigned GET URL expiry for both playback and download confirmed at 1h during phase-plan validation. Rationale: 1h covers a normal viewing/download session while keeping the short-lived exposure window the direct-from-storage model relies on; longer sessions refresh the URL via a new request.

---

## TD-09: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The `videos` row carries a `status` that reflects where the video is in its lifecycle (draft → uploading → processing → ready/failed) and drives what the channel owner sees. The decision is what the source of truth for status is and how processing failures are handled so a broken video does not sit forever in "processing".

**Options:**

### Option A: DB `status` enum as source of truth + queue-native retries, terminal `failed`
- A `status` enum column on `videos` is the authoritative state. The worker transitions `processing → ready` on success and, on error, relies on BullMQ's bounded `attempts` + exponential `backoff`; after attempts are exhausted, the job's failure handler sets `status = 'failed'` with an error reason. Draft is created at upload start (`draft`/`uploading`).
- **Pros:** Single, queryable source of truth the API and frontend already read (`videos.status`) — no need to inspect queue internals to render the channel dashboard. Bounded retries handle transient FFmpeg/storage hiccups; a terminal `failed` state guarantees no video is stuck forever and enables a "retry"/"delete" UX later. Idempotent transitions keyed on the video id. Uses TD-01's built-in retry/backoff — no custom retry engine.
- **Cons:** Status is duplicated between the DB and the queue's own job state — they must be kept consistent via the job's completion/failure handlers (the DB write is the authoritative one).

### Option B: Queue job state as source of truth
- Derive status by querying the queue (waiting/active/completed/failed) instead of a DB column.
- **Pros:** No duplicated state; the queue already tracks job progress.
- **Cons:** Couples every status read (channel dashboard, API responses) to the queue, and job records are pruned/TTL'd — historical status of an old `ready` video would be lost. The frontend would need queue access. Poor fit for a persistent domain attribute. Rejected.

### Option C: Outbox/saga with a dedicated state machine
- Model the lifecycle as an explicit saga with an outbox table for transitions.
- **Pros:** Rigorous, auditable transitions; strong consistency between enqueue and state change.
- **Cons:** Substantial machinery for a linear, short lifecycle with one heavy step. Over-engineered at this scope; the transactional-enqueue benefit is marginal with a client-callback trigger (TD-04). Defer unless the lifecycle grows branches.

**Recommendation:** **Option A (DB enum + queue-native retries + terminal `failed`)** — keeps a single queryable source of truth the whole system already reads, leans on BullMQ's built-in bounded retries/backoff (TD-01) for transient failures, and guarantees a terminal `failed` state so nothing hangs in "processing". Transitions are written from the worker's job completion/failure handlers, with the DB row authoritative. Depends on TD-01 (retry/backoff) and TD-04 (draft creation / enqueue point).

**Decision:** Option A (DB enum + queue-native retries + terminal `failed`)

**Revisions:**
- 2026-07-09 — Lifecycle enum simplified to `draft → processing → ready | failed`; the intermediate `uploading` state was dropped. The row stays `draft` throughout the direct-to-storage upload and transitions straight to `processing` on the verified completion callback (TD-04). Rationale: with bytes going browser→storage (TD-02), the API never observes a distinct `uploading` phase separate from `draft`; a single pre-upload state removes a redundant transition and matches the implemented status enum in the phase plan (SI-03.6, Data Model).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue / Background Job Technology | BullMQ + Redis (`@nestjs/bullmq`) | Option A (Redis) |
| TD-02 | Cross-layer | Large-File Upload Strategy (10GB) | S3 Presigned Multipart (direct browser → storage) | Option A (S3 Presigned Multipart)  |
| TD-03 | Backend | Object Storage Layout & Access | Single bucket, prefixed keys, presigned access | Option A (single bucket, prefixed keys) |
| TD-04 | Cross-layer | Upload-Completion Trigger → Enqueue | Client callback + `HeadObject` verification | Option A (client callback + `HeadObject` verification)  |
| TD-05 | Backend | Video Worker Runtime | Dedicated worker container | Option A (dedicated worker container)  |
| TD-06 | Backend | FFmpeg / ffprobe Integration | Direct `child_process` spawn | Option A (direct `child_process` spawn)  |
| TD-07 | Cross-layer | Unique Video URL Identifier | `nanoid` in dedicated `public_id` column | Option A (`nanoid` in a dedicated `public_id` column)  |
| TD-08 | Cross-layer | Streaming & Download Delivery | Presigned GET, direct-from-storage (native Range/206) | Option A (presigned GET, direct-from-storage) |
| TD-09 | Backend | Video Status Lifecycle & Failure Handling | DB enum + queue-native retries + terminal `failed` | Option A (DB enum + queue-native retries + terminal `failed`) |
