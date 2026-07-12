# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/10 completed

### SI-03.1 — Infra: serviços MinIO + Redis e configs
- **Status:** completed
- **Tests:** _(empty — Infra)_
- **Observations:**
  - Initially added a `createbuckets` compose-only init container (minio/mc) to provision the `streamtube-media` bucket. Removed after `/simplify` review (altitude finding): bucket creation via a compose shell side-channel has no production equivalent and would duplicate/conflict with the real bucket-provisioning logic `StorageService` needs anyway (SI-03.3) for prod parity — deferred there instead. Also dropped the premature `nestjs-api → minio/redis` `depends_on` added alongside it (simplification finding): nothing in this SI's code talks to either service yet; SI-03.3/SI-03.6 will add that coupling when they actually wire in clients.
  - Verified ACs by validating the Joi schema directly (`ts-node -e`) rather than booting the dev server — this project's container convention keeps `nestjs-api` idle (`tail -f /dev/null`) until `npm run start:dev` is run explicitly; starting it is out of scope per `nestjs-project/CLAUDE.md`.

### SI-03.2 — Entidade Video + migration + VideosModule
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.3 — StorageService (adaptador S3/MinIO)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

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
