# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/10 completed

### SI-03.1 — Infra: serviços MinIO + Redis e configs
- **Status:** completed
- **Tests:** _(empty — Infra)_
- **Observations:**
  - Initially added a `createbuckets` compose-only init container (minio/mc) to provision the `streamtube-media` bucket. Removed after `/simplify` review (altitude finding): bucket creation via a compose shell side-channel has no production equivalent and would duplicate/conflict with the real bucket-provisioning logic `StorageService` needs anyway (SI-03.3) for prod parity — deferred there instead. Also dropped the premature `nestjs-api → minio/redis` `depends_on` added alongside it (simplification finding): nothing in this SI's code talks to either service yet; SI-03.3/SI-03.6 will add that coupling when they actually wire in clients.
  - Verified ACs by validating the Joi schema directly (`ts-node -e`) rather than booting the dev server — this project's container convention keeps `nestjs-api` idle (`tail -f /dev/null`) until `npm run start:dev` is run explicitly; starting it is out of scope per `nestjs-project/CLAUDE.md`.

### SI-03.2 — Entidade Video + migration + VideosModule
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - Added `OneToMany` inverse side (`videos`) to the existing `Channel` entity to satisfy the bidirectional relation required by TypeORM conventions — not listed as an explicit technical action in the SI text but implied by "Adicionar o lado inverso OneToMany em Channel".
  - `size_bytes` (bigint) typed as `string | null` on the entity per TypeORM's standard bigint-to-string mapping (avoids JS number precision loss) — not spelled out in the Data Model table's Type column but is the project's implicit TypeORM convention.
  - `/simplify` pass (4 parallel review agents — reuse/simplification/efficiency/altitude): applied 2 fixes — (1) removed a redundant `DELETE FROM "videos"` line from the shared `cleanAllTables` test helper (the FK's `ON DELETE CASCADE` from `channels` already covers it); (2) extracted a `createVideo()` helper in `video.entity.integration-spec.ts` to remove copy-paste across 4 tests. Skipped 2 findings as false positives given full plan context: the `status` index (flagged as premature) is explicitly required by the plan's Data Model for SI-03.9's stale-uploads reconciliation scan; the DB-backed `.spec.ts` module-compilation pattern in `videos.module.spec.ts` (flagged as inefficient) matches the codebase-wide convention used by every other `*.module.spec.ts` file — fixing only this one would introduce inconsistency.
  - Post-simplify verification surfaced a real regression from adding `Channel.videos`: TypeORM's metadata builder fails at `DataSource.initialize()` for any test file whose local entity array includes `Channel` but not `Video` (`computeInverseProperties` can't resolve the relation target). Fixed by adding `Video` to the entity array in all 10 affected sibling files: `channels/entities/channel.entity.integration-spec.ts`, `channels/channels.module.spec.ts`, `channels/channels.service.integration-spec.ts`, `users/users.module.spec.ts`, `users/entities/user.entity.integration-spec.ts`, `users/users.service.integration-spec.ts`, `auth/auth.module.spec.ts`, `auth/entities/refresh-token.entity.integration-spec.ts`, `auth/entities/verification-token.entity.integration-spec.ts`, `auth/auth.service.integration-spec.ts`, `database/migrations.integration-spec.ts`. Full suite reconfirmed green after the fix (24/25 suites, 146/149 tests — see next bullet for the one pre-existing unrelated failure).
  - **Out of scope, not fixed:** `src/config/env.validation.integration-spec.ts` has 3 pre-existing failing tests (`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` required but not supplied by those tests' partial env objects) — predates this SI, introduced by the already-committed SI-03.1 work. Flagging for a separate fix rather than folding into SI-03.2.

### SI-03.3 — StorageService (adaptador S3/MinIO)
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Bucket `streamtube-media` already existed in MinIO (verified via `mc ls`) — no bucket-provisioning logic was added here; the SI's 3 technical actions (service, key helper, module) did not call for it, and SI-03.1's deferral note turned out moot since the bucket was already present.
  - Installed `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (^3.1085.0) — not previously in package.json.
  - Integration test proves the presigned-URL round-trip for real (PUT via `presignUploadPart`, GET via `presignGetObject`) using Node's global `fetch`, rather than asserting against mocked SDK calls — matches the SI's "round-trip real contra MinIO" Tests requirement.
  - `/simplify` pass (4 parallel review agents — reuse/simplification/efficiency/altitude): applied 3 fixes — (1) extracted a shared `uploadAndComplete()` helper in the integration spec to remove the copy-pasted create→presign→PUT→complete sequence across 3 tests; (2) removed the redundant `bucket` field on `StorageService` (was just a copy of `this.config.bucket`) in favor of reading `this.config.bucket` directly; (3) simplified the conditional-spread construction of `ResponseContentDisposition` in `presignGetObject` to a plain ternary. Also relocated `storage-key.util.ts` → `src/videos/video-storage-key.util.ts` (altitude finding): the generic `storage` adapter module had no business encoding "video"/"thumbnail" path-layout knowledge — that's a `videos`-domain concern, and no code consumed the helper yet so the move was zero-risk. Skipped one finding (reuse agent flagged the bare `throw new Error(...)` for the "S3 didn't return an UploadId" case as bypassing the project's `DomainException` hierarchy): kept it as a plain `Error` because it mirrors an existing precedent for the same category of failure (`channels.service.ts`'s "nickname conflict could not be resolved" bare `Error`) — an internal SDK-contract assertion that should never happen and isn't in the phase's Error Catalog, not a user-facing business rule a `DomainException` subclass is meant to represent.
  - The refactor surfaced a real, previously-undetected `tsc --noEmit` failure: `fetch(url, { body: content })` with `content: Buffer` doesn't satisfy the DOM lib's `BodyInit` type (Jest/ts-jest hadn't caught it, since the tests passed at runtime — Node's `fetch` accepts `Buffer` fine). Fixed by passing `new Uint8Array(content)` instead. This was latent since the very first version of this file (all 4 original inline occurrences), just never surfaced because `tsc` hadn't been re-run after the initial implementation until this `/simplify` pass's verification step.

### SI-03.6 — Infra: fila BullMQ + container de worker dedicado
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.4 — Endpoint POST /videos (início do upload)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — FFmpegService (ffprobe + thumbnail)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — Endpoint POST /videos/:publicId/complete (conclusão + enfileiramento)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — Processor do job video.process
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Varredura de reconciliação de uploads obsoletos
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Endpoints de leitura e entrega (detalhes + streaming + download)
- **Status:** pending
- **Tests:** pending
- **Observations:** none
