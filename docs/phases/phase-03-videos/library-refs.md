---
libs:
  "bullmq":
    version: "^5.80.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-14T11:33:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-14T11:33:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1085.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-14T11:33:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1085.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-14T11:33:00-03:00"
  "nanoid":
    version: "^3.3.16"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-14T11:33:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-14T11:25:04-03:00"
---

# phase-03-videos — Library References

Distilled Context7 docs for the libraries introduced by this phase's decided TDs (TD-01, TD-02, TD-07), scoped to the surfaces this phase's SIs actually use.

## bullmq

**TD-01 — Message Queue.** Producer-side APIs used by `VideosService` (enqueue) and `VideoProcessingWorkerModule` (repeatable scan scheduler).

### Add a job with bounded attempts + exponential backoff

```typescript
import { Queue } from 'bullmq';

const myQueue = new Queue('foo');

await queue.add(
  'test-retry',
  { foo: 'bar' },
  {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
);
```

### Repeatable job scheduler (`upsertJobScheduler`) — current API, not the deprecated `repeat` option

```typescript
const { Queue, Worker } = require('bullmq');

const myQueue = new Queue('my-repeatable-jobs', { connection });

await myQueue.upsertJobScheduler(
  'repeat-every-10s',
  { every: 10000 },
  {
    name: 'every-job',
    data: { jobData: 'data' },
    opts: {},
  },
);
```

Matches this project's usage: `VideoProcessingWorkerModule.onModuleInit()` calls `upsertJobScheduler` with `STALE_UPLOADS_SCAN_INTERVAL_MS` (1h) against the `video-processing` queue, dispatched by `job.name` inside the single `@Processor`'s `process()` (BullMQ binds one Worker per queue name — a second `@Processor` on the same queue would race).

## @nestjs/bullmq

**TD-01 — Message Queue (NestJS integration).** Context7 only indexes this under the `/nestjs/bull` library id, which covers both the legacy Bull and current BullMQ NestJS modules — API shown below is the `@nestjs/bullmq` (`bullmq`-backed) variant actually installed.

### Module registration — `forRootAsync` + `useFactory`

```typescript
BullModule.forRootAsync({
  useFactory: () => ({
    connection: {
      host: '0.0.0.0',
      port: 6380,
    },
  }),
})
```

### Processor — `@Processor` + `WorkerHost`, not the older `@Process()` method-decorator style

```typescript
@Processor(queueName)
class TestProcessor extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    // ...
  }

  @OnWorkerEvent('completed')
  onCompleted() {}
}
```

`@InjectQueue(name)` injects the `Queue` instance for producers; `@Processor(queueName)` + `extends WorkerHost` + `process(job)` is the consumer shape. Matches this project's `VideoProcessingProcessor` (in `VideoProcessingWorkerModule`, kept separate from `VideoProcessingModule` so `nestjs-api` never instantiates a live Worker — see SI-03.8 observations).

## @aws-sdk/client-s3

**TD-02 — Large-file multipart upload; TD-03 — object storage layout; TD-08 — delivery via `GetObject`.** Matches this project's `StorageService` commands: `CreateMultipartUploadCommand` → `UploadPartCommand` (per part) → `CompleteMultipartUploadCommand`; `HeadObjectCommand` for completion verification; `GetObjectCommand`/`PutObjectCommand` for the worker's raw object I/O.

### HeadObjectCommand — metadata / existence / size check (used by `completeUpload`'s verification step)

```
HEAD /{Bucket}/{Key}
```
Returns headers only (`Content-Length`, `ETag`, `Last-Modified`, ...) — no body download. This project's `completeUpload` compares the returned `ContentLength` against the client-declared `size_bytes` to detect a lying/partial client.

### GetObjectCommand — Node.js stream consumption pattern

```typescript
const command = new GetObjectCommand(input);
const response = await client.send(command);
// consume or destroy the stream to free the socket
const bytes = await response.Body.transformToByteArray();
// response.Body.destroy(); // Node.js Readable only
```

`StorageService.getObjectStream(key)` returns `response.Body` typed as a Node `Readable` directly (rather than buffering via `transformToByteArray`), since the worker pipes it straight to a local temp file for FFmpeg to read.

### CompleteMultipartUploadCommand — request shape

Requires the ordered `Part` list (`ETag` + `PartNumber` per part) collected from each `UploadPartCommand` response during the upload.

## @aws-sdk/s3-request-presigner

**TD-02 — presigned `UploadPart` URLs (12h expiry, 50MiB parts); TD-08 — presigned `GetObject` URLs (1h expiry) for playback/download.**

### `getSignedUrl` — core signature

```javascript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client(clientParams);
const command = new GetObjectCommand(getObjectParams);
const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` defaults to 900s when omitted — this project always passes it explicitly (`GET_OBJECT_URL_EXPIRES_IN_SECONDS`, `PART_UPLOAD_URL_EXPIRES_IN_SECONDS` constants in `StorageService`, per TD-02/TD-08's confirmed values).

### Forced download via `response-content-disposition`

`ResponseContentDisposition` on the `GetObjectCommand` input is signed into the URL as a `response-content-disposition` query parameter — this is how `StorageService.presignGetObject`'s `downloadFilename` option (used by `getDownloadUrl`) forces `Content-Disposition: attachment` without proxying bytes through the API.

### v2 → v3 migration note

v2's `s3.getSignedUrl()` / `getSignedUrlPromise()` are replaced by the standalone `@aws-sdk/s3-request-presigner` package in v3 — no client-bound method, just the `getSignedUrl(client, command, options)` free function shown above. Relevant since AI training data / older tutorials may reference the v2 shape.

## nanoid

**TD-07 — `public_id` short URL identifier (11 chars, dedicated column).** Project installs `nanoid@3` deliberately, not the latest v5 — v5 is ESM-only and fails to `require()` under this project's `nodenext`/CommonJS TypeScript config; v3 ships a dual CJS/ESM build.

### Install v3 explicitly

```bash
npm install nanoid@3
```

### Generate with custom size

```javascript
import { nanoid } from 'nanoid'
nanoid(10) //=> "IRFa-VaY2b"
```

Default alphabet is already URL-safe (`urlAlphabet`). This project calls `nanoid(11)` inside `generateUniquePublicId`, which owns the full regenerate-on-collision retry loop (takes an `exists` callback) per TD-07's "unique constraint + retry-on-collision" decision.
