# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos Module

Upload, storage and background processing of videos (Fase 03). Four modules divide the responsibility:

- **`VideosModule`** (`src/videos/`) — `VideosController` + `VideosService`. Owns the `videos` table and the upload/read/delivery endpoints. Imported by `AppModule`.
- **`StorageModule`** (`src/storage/`) — `StorageService`, a thin adapter over the AWS S3 SDK pointed at MinIO (`STORAGE_ENDPOINT`). Multipart upload, presigned URLs, raw object get/put.
- **`VideoProcessingModule`** (`src/video-processing/`) — registers the BullMQ queue (`VIDEO_PROCESSING_QUEUE = 'video-processing'`) and `FFmpegService`. Imported by both `AppModule` (producer side, via `VideosModule`) and the worker (consumer side) — it never declares the `@Processor` itself, so `nestjs-api` enqueues jobs but never consumes them.
- **`VideoProcessingWorkerModule`** (`src/video-processing/video-processing-worker.module.ts`) — worker-only. Declares `VideoProcessingProcessor` (the actual `@Processor(VIDEO_PROCESSING_QUEUE)`) and registers the repeatable stale-uploads scan. Imported only by `WorkerModule` (`src/worker.module.ts`, entry point `src/worker.ts`), which runs in the dedicated `video-worker` container — never inside `nestjs-api`.

### Entity & status lifecycle

`Video` (table `videos`, `src/videos/entities/video.entity.ts`) belongs to a `Channel` (`channel_id`, `ON DELETE CASCADE`). Key columns: `public_id` (unique, nanoid-based external identifier), `status`, `storage_key`, `thumbnail_key`, `upload_id`, `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `size_bytes`, `failure_reason`.

`status` (`VideoStatus` enum, `src/videos/entities/video-status.enum.ts`): `draft → processing → ready | failed`. Set to `draft` when the upload is initiated, `processing` when the client confirms completion (enqueues the job), `ready`/`failed` by the worker. `failed` is terminal — no automatic retry beyond the queue's own attempt budget.

### Upload flow (direct-to-storage, up to 10GB)

The API never streams video bytes — it only issues storage credentials. Enforced by `MAX_VIDEO_SIZE_BYTES` (10GB) and `VIDEO_UPLOAD_PART_SIZE_BYTES` (50MiB) in `src/videos/videos.constants.ts`.

1. `POST /videos` — pre-registers the video as `draft`, opens an S3 multipart upload, returns one presigned `UploadPart` URL per part.
2. Client `PUT`s each part directly to MinIO/S3.
3. `POST /videos/:publicId/complete` — completes the multipart upload, verifies the object in storage (`HeadObject` existence + size match), transitions `draft → processing`, and enqueues a `video.process` job (`{ videoId }`) on the BullMQ queue.

### Background processing (worker)

The `video-worker` container (same `Dockerfile.dev`, built with `EXTRA_PACKAGES=ffmpeg`) runs `VideoProcessingProcessor`, which handles two job types on the same queue (BullMQ requires one `@Processor` per queue, so dispatch is by `job.name`):

- **`video.process`** — downloads the source object, runs `FFmpegService` (direct `child_process` spawn of `ffprobe`/`ffmpeg`, no wrapper library) to extract duration/width/height/codecs (`ffprobe`) and a thumbnail frame at 10% of the duration (`ffmpeg`), uploads the thumbnail, persists metadata and flips `status → ready`. Reprocessing an already-`ready` video short-circuits (idempotent). Permanent failures (e.g. no video stream) mark `status → failed` immediately via `UnrecoverableError`; transient failures rely on BullMQ's retry/backoff (`VIDEO_PROCESSING_JOB_ATTEMPTS = 3`, `VIDEO_PROCESSING_JOB_BACKOFF_DELAY_MS = 5000`) and only persist `failed` on the last attempt.
- **`video.reconcile-stale-uploads`** — a repeatable job (`upsertJobScheduler`, every `STALE_UPLOADS_SCAN_INTERVAL_MS` = 1h) that marks `draft` videos older than `STALE_UPLOAD_TTL_MS` (24h) as `failed`, aborting their multipart upload in storage.

`nestjs-api` only ever produces `video.process` jobs (via `VideosService`); it never runs a `@Processor`, so it never consumes them — that requires the `ffmpeg`/`ffprobe` binaries, which only the `video-worker` image has. Tests under `src/video-processing/*.integration-spec.ts` that need real ffmpeg must run inside that container: `docker compose exec video-worker npm test -- --runInBand <file>`.

### Streaming, download & unique URL

`public_id` (11-char nanoid) is the only video identifier ever exposed externally — never the internal UUID `id`. Storage keys follow `videos/{channelId}/{videoId}/original` and `thumbnails/{channelId}/{videoId}/thumb.jpg` (`src/videos/video-storage-key.util.ts`).

- `GET /videos/:publicId` — status/metadata. Public for `ready` videos; non-ready videos are visible only to the owning channel (`@OptionalAuth()` — missing/invalid token doesn't 401, it just proceeds unauthenticated).
- `GET /videos/:publicId/playback-url` / `GET /videos/:publicId/download-url` — `@Public()`, return a presigned `GetObject` URL (`GET_OBJECT_URL_EXPIRES_IN_SECONDS` = 1h) for direct streaming/download from MinIO/S3. `404` if the video doesn't exist, `409` if not yet `ready` (owner included — these two endpoints have no owner bypass). Download forces `content-disposition: attachment`. Range requests / `206 Partial Content` for seeking are handled natively by MinIO/S3 — the API is never in the byte path.

### Infrastructure (Compose)

- `minio` — S3-compatible object storage (API :9000, console :9001), credentials from `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`.
- `redis` — BullMQ's backing store (`REDIS_HOST`/`REDIS_PORT`).
- `video-worker` — the dedicated consumer described above; depends on `db`, `minio`, `redis`.

New env vars (see `.env.example`): `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `REDIS_HOST`, `REDIS_PORT`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
