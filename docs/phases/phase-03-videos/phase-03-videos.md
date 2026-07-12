---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-11T18:04:21-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-09T15:01:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-11T16:25:06-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar a fundação de backend para upload e processamento de vídeos no `nestjs-project`: armazenamento de arquivos em object storage (MinIO/S3), fila de processamento em segundo plano (BullMQ + Redis), upload direto-ao-storage de arquivos de até 10GB via S3 multipart presigned, pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático em worker dedicado (extração de duração/metadados + geração de thumbnail via FFmpeg), URL única por vídeo (`public_id` nanoid), e entrega por streaming/download através de presigned GET URLs — com ciclo de vida de status `draft → processing → ready | failed`.

---

## Step Implementations

### SI-03.1 — Infra: serviços MinIO + Redis e configs

**Description:** Adicionar object storage (MinIO) e fila (Redis) como serviços do Docker Compose e criar as configs namespaced correspondentes, estabelecendo a infraestrutura que as demais SIs consomem.

**Technical actions:**

1. Adicionar serviço `minio` (S3-compatible) ao `docker-compose.yml` — porta/console, bucket `streamtube-media`, credenciais via env (`phase-03-videos/TD-03`).
2. Adicionar serviço `redis` ao `docker-compose.yml` — backing store da fila BullMQ (`phase-03-videos/TD-01`).
3. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com endpoint (`minio`), região, bucket, credenciais (herda o padrão de config namespaced de `phase-01-configuracao-base/TD-03`).
4. Criar `src/config/redis.config.ts` — `registerAs('redis', ...)` com host (`redis`), porta (nunca `localhost` — DNS de serviço Compose).
5. Estender o schema Joi em `src/config/env.validation.ts` com as novas variáveis (`STORAGE_*`, `REDIS_*`), seguindo `phase-01-configuracao-base/TD-02`.

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os serviços `minio` e `redis` com status `running`.
- A aplicação inicia sem erro de validação de env com as novas variáveis `STORAGE_*`/`REDIS_*` presentes.
- A aplicação aborta o startup quando uma variável obrigatória de `STORAGE_*`/`REDIS_*` está ausente (validação Joi).

---

### SI-03.2 — Entidade Video + migration + VideosModule

**Description:** Criar a entidade `Video` (tabela `videos`) ligada a `Channel`, com o enum de status e a migration, mais o scaffold do `VideosModule`.

**Technical actions:**

1. Criar `src/videos/entities/video-status.enum.ts` — `draft | processing | ready | failed` (`phase-03-videos/TD-09`).
2. Criar `src/videos/entities/video.entity.ts` — campos e constraints per `## Technical Specifications → Data Model → Video` (PK uuid, `public_id` unique 11 chars, FK `channel_id` cascade, `status` default `draft`, chaves de objeto, metadados nullable) (`phase-03-videos/TD-03`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`).
3. Adicionar o lado inverso `OneToMany` em `Channel` (`videos`) — relação bidirecional com `Video`.
4. Gerar a migration da tabela `videos` (enum `video_status`, índices unique `public_id`, index `channel_id`, index `status`).
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, default `status = draft`, FK cascade para `Channel`, índices | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilation test (DI wiring) | `src/videos/videos.module.spec.ts` |

**Dependencies:** none _(Channel já entregue em phase-02; DB em phase-01)_

**Acceptance criteria:**

- Inserir dois `Video` com o mesmo `public_id` viola a constraint unique.
- Um `Video` criado sem `status` explícito persiste com `status = draft`.
- Remover um `Channel` remove em cascata os `Video` associados.

---

### SI-03.3 — StorageService (adaptador S3/MinIO)

**Description:** Encapsular o SDK S3 num serviço tipado que oferece as operações de multipart, verificação e presign usadas pelo upload e pela entrega — mantendo os bytes fora da API.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — cliente S3 (`@aws-sdk/client-s3`) configurado por `storageConfig`, com `createMultipartUpload`, `presignUploadPart` (`@aws-sdk/s3-request-presigner`, expiry 12h), `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGetObject` (expiry 1h, opção `downloadFilename` para content-disposition) (`phase-03-videos/TD-02`, `phase-03-videos/TD-08`).
2. Criar helper de layout de chave — `videos/{channelId}/{videoId}/original` e `thumbnails/{channelId}/{videoId}/thumb.jpg` (`phase-03-videos/TD-03`).
3. Criar `src/storage/storage.module.ts` exportando `StorageService`; importar `ConfigModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: round-trip real contra MinIO — multipart init/part/complete, `headObject` de objeto existente, presign GET/PUT válidos | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (`storageConfig` + serviço MinIO)

**Acceptance criteria:**

- `headObject` de uma chave inexistente sinaliza ausência (não confirma objeto).
- Uma presigned PUT URL emitida permite `PUT` direto no MinIO sem passar pela API.
- Uma presigned GET URL com `downloadFilename` retorna `Content-Disposition: attachment`.

---

### SI-03.4 — Endpoint POST /videos (início do upload)

**Description:** Iniciar o upload: pré-cadastrar o vídeo como `draft` com `public_id` único, abrir o multipart no storage e devolver as URLs presigned das partes.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-init.plan.md`
**Authorization:** Authenticated (cria no próprio canal) — per `## Technical Specifications → Authorization Matrix`

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — gera `public_id` nanoid de 11 chars com regenera-em-colisão contra a constraint unique (`phase-03-videos/TD-07`).
2. Criar `src/videos/dto/create-video.dto.ts` — `title?`, `filename`, `sizeBytes`, `contentType` com regras de `## Technical Specifications → API Contracts → Validation Rules` (class-validator, per `phase-02-auth/TD-06`).
3. Implementar `VideosService.initiateUpload` — cria a linha `draft`, chama `StorageService.createMultipartUpload`, calcula a contagem de partes (`sizeBytes / 50MiB`) e presign de cada `UploadPart` (`phase-03-videos/TD-02`, `phase-03-videos/TD-04`).
4. Criar `src/videos/videos.controller.ts` com `POST /videos` protegido pelo guard JWT herdado + resolução do canal do usuário autenticado; resposta per `## Technical Specifications → API Contracts → POST /videos`.
5. Adicionar decorators OpenAPI (`@nestjs/swagger`, per `openapi-docs-nestjs/TD-01`) ao endpoint e ao DTO.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: cálculo de partes, regenera-em-colisão do `public_id` (mock repo + StorageService) | `src/videos/videos.service.spec.ts` |
| `public-id.util` | Unit: formato 11 chars URL-safe, retry em colisão | `src/videos/public-id.util.spec.ts` |

_E2E do endpoint são autorados externamente via `/plan-test-specs` (ver `**Test Specs:**`)._

**Dependencies:** SI-03.2 (entidade Video) + SI-03.3 (StorageService)

**Acceptance criteria:**

- `POST /videos` autenticado com body válido retorna `201` com `publicId`, `uploadId`, `key`, `partSize` e `parts` (URLs presigned).
- `POST /videos` sem sessão válida retorna `401`.
- `POST /videos` com `sizeBytes` acima de 10GB ou `filename` ausente retorna `400`.
- Após um `POST /videos` bem-sucedido existe uma linha `videos` com `status = draft` e `public_id` de 11 chars.

---

### SI-03.5 — Endpoint POST /videos/:publicId/complete (conclusão + enfileiramento)

**Description:** Finalizar o upload direto-ao-storage: completar o multipart, verificar o objeto, transicionar `draft → processing` e enfileirar o job de processamento.

**Route:** POST /videos/:publicId/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner — per `## Technical Specifications → Authorization Matrix`

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber, etag }[]` (class-validator).
2. Implementar `VideosService.completeUpload` — `completeMultipartUpload` + `headObject` (verifica existência e tamanho); em falha lança `UPLOAD_VERIFICATION_FAILED` (`phase-03-videos/TD-04`).
3. Transicionar `draft → processing` (rejeita status ≠ `draft` com `INVALID_UPLOAD_STATE`) e limpar `upload_id`; enfileirar `video.process` na fila (`phase-03-videos/TD-04`, `phase-03-videos/TD-09`).
4. Adicionar `POST /videos/:publicId/complete` ao controller com guard JWT + verificação de propriedade do canal no service (`FORBIDDEN_VIDEO_ACCESS`); resposta per `## Technical Specifications → API Contracts`.
5. Criar as exceções de domínio `InvalidUploadStateException`, `UploadVerificationFailedException`, `ForbiddenVideoAccessException`, `VideoNotFoundException` mapeando os `errorCode`s de `## Technical Specifications → Error Catalog` (via filtro herdado `phase-02-auth/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: verificação HeadObject falha → exceção, transição só a partir de `draft`, enfileira job (mock repo + storage + queue) | `src/videos/videos.service.spec.ts` |
| `video.process` enqueue | Integration: conclusão verificada persiste `status = processing` e publica o job na fila real | `src/videos/videos.service.integration-spec.ts` |

_E2E do endpoint são autorados externamente via `/plan-test-specs` (ver `**Test Specs:**`)._

**Dependencies:** SI-03.4 (endpoint de início) + SI-03.6 (fila para enfileirar)

**Acceptance criteria:**

- `POST /videos/:publicId/complete` do dono, com objeto presente no storage, retorna `200` com `status: "processing"`.
- `POST /videos/:publicId/complete` para vídeo cujo `status` ≠ `draft` retorna `409 INVALID_UPLOAD_STATE`.
- `POST /videos/:publicId/complete` quando o `HeadObject` não confirma o objeto retorna `422 UPLOAD_VERIFICATION_FAILED`.
- `POST /videos/:publicId/complete` por autenticado que não é dono do canal retorna `403 FORBIDDEN_VIDEO_ACCESS`.

---

### SI-03.6 — Infra: fila BullMQ + container de worker dedicado

**Description:** Registrar a fila `video-processing` (BullMQ/Redis) e criar o entrypoint do worker dedicado com FFmpeg, isolando o processamento pesado da API.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` (conexão Redis via `redisConfig`) e `BullModule.registerQueue({ name: 'video-processing' })` num `VideoProcessingModule` (`@nestjs/bullmq`, `phase-03-videos/TD-01`).
2. Criar `src/worker.ts` — bootstrap de um application context NestJS **sem** servidor HTTP, carregando `VideoProcessingModule` (`phase-03-videos/TD-05`).
3. Configurar `defaultJobOptions` da fila com `attempts` limitado + `backoff` exponencial (`phase-03-videos/TD-01`, serve a `phase-03-videos/TD-09`).
4. Adicionar serviço `video-worker` ao `docker-compose.yml` — imagem com FFmpeg/ffprobe instalados, rodando `node dist/worker.js`, mesma base de código do monorepo (`phase-03-videos/TD-05`).
5. Injetar a `Queue` em `VideosService` (producer) para o enfileiramento usado por SI-03.5.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingModule` | Unit: compilation test (registro da fila + DI) | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.1 (`redisConfig` + serviço Redis) + SI-03.2 (entidade/módulo para o contexto do worker)

**Acceptance criteria:**

- O container `video-worker` sobe e conecta na fila Redis sem iniciar servidor HTTP.
- Um job enfileirado em `video-processing` fica visível para um consumidor conectado à mesma fila.
- `ffmpeg -version` e `ffprobe -version` executam dentro da imagem do worker.

---

### SI-03.7 — FFmpegService (ffprobe + thumbnail)

**Description:** Serviço tipado que invoca ffprobe/ffmpeg diretamente via `child_process`, extraindo metadados e um frame de thumbnail com timeouts e captura de stderr.

**Technical actions:**

1. Criar `src/video-processing/ffmpeg.service.ts` — `probe(path)` executando `ffprobe -show_format -show_streams -print_format json` e parseando duração/dimensões/codecs (`phase-03-videos/TD-06`).
2. Implementar `extractThumbnail(path, durationSeconds)` — `ffmpeg -ss <10% da duração> -frames:v 1` gravando o frame (`phase-03-videos/TD-06`).
3. Envolver os `spawn` com timeout explícito e captura de stderr, lançando erro tipado quando o processo falha ou não há stream de vídeo (alimenta o tratamento de falha de `phase-03-videos/TD-09`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FFmpegService.probe` | Integration: fixture de vídeo real → duração/codecs corretos; fixture sem stream de vídeo → erro | `src/video-processing/ffmpeg.service.integration-spec.ts` |
| `FFmpegService.extractThumbnail` | Integration: gera um arquivo de imagem a partir do frame a 10% | `src/video-processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (worker com FFmpeg instalado)

**Acceptance criteria:**

- `probe` de um vídeo válido retorna `durationSeconds`, `width`, `height`, `videoCodec` e `audioCodec`.
- `probe` de um arquivo sem stream de vídeo lança erro tipado (não retorna metadados parciais).
- `extractThumbnail` produz um arquivo de imagem correspondente ao frame a 10% da duração.

---

### SI-03.8 — Processor do job video.process

**Description:** Consumir o job `video.process`: baixar/streamar a fonte do storage, extrair metadados e thumbnail, publicar a thumbnail e transicionar o vídeo para `ready` (ou `failed`).

**Technical actions:**

1. Criar `src/video-processing/video-processing.processor.ts` — `@Processor('video-processing')` consumindo `video.process` (`phase-03-videos/TD-05`, `phase-03-videos/TD-08`).
2. Orquestrar: obter a fonte do storage → `FFmpegService.probe` → `FFmpegService.extractThumbnail` → `StorageService` upload da thumbnail (`thumbnail_key`) (`phase-03-videos/TD-06`).
3. Em sucesso: `UPDATE` da linha `videos` com metadados + `thumbnail_key` + `status = ready`, idempotente por `videoId` (`phase-03-videos/TD-09`).
4. Em falha após esgotar os `attempts` do BullMQ (ou fonte sem stream de vídeo): handler grava `status = failed` + `failure_reason` (`phase-03-videos/TD-09`, `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: caminho de sucesso persiste `ready` + metadados; falha do ffprobe persiste `failed` + `failure_reason` (mock FFmpeg/Storage/repo) | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration: job real (fila + DB) leva `processing → ready` com `thumbnail_key` preenchido | `src/video-processing/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.6 (fila) + SI-03.7 (FFmpegService) + SI-03.3 (StorageService) + SI-03.2 (entidade Video)

**Acceptance criteria:**

- Processar um vídeo válido transiciona `processing → ready` e preenche `durationSeconds` e `thumbnail_key`.
- Processar uma fonte sem stream de vídeo transiciona para `failed` com `failure_reason` não-nulo.
- Reprocessar o mesmo `videoId` já em `ready` não corrompe a linha (transição idempotente).

---

### SI-03.9 — Varredura de reconciliação de uploads obsoletos

**Description:** Job repetível que reclama rascunhos abandonados: aborta o multipart no storage e marca como obsoletos os vídeos presos em `draft` além do TTL de 24h.

**Technical actions:**

1. Registrar um job repetível `video.reconcile-stale-uploads` na fila (scheduling do BullMQ, `phase-03-videos/TD-01`).
2. Criar o handler `src/video-processing/stale-uploads.processor.ts` — consulta `videos` em `draft` com `created_at` além de 24h (`phase-03-videos/TD-04`).
3. Para cada rascunho obsoleto: `StorageService.abortMultipartUpload` (usando `upload_id`) e marcar a linha como obsoleta; operação idempotente.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StaleUploadsProcessor` | Integration: rascunho com `created_at` > 24h é reclamado e o multipart é abortado; rascunho recente é ignorado | `src/video-processing/stale-uploads.processor.integration-spec.ts` |

**Dependencies:** SI-03.6 (scheduling da fila) + SI-03.3 (`abortMultipartUpload`) + SI-03.2 (entidade Video)

**Acceptance criteria:**

- Um vídeo em `draft` com `created_at` além de 24h é reclamado pela varredura e tem o multipart abortado.
- Um vídeo em `draft` dentro da janela de 24h não é afetado pela varredura.
- Rodar a varredura duas vezes sobre o mesmo rascunho obsoleto não gera erro (idempotente).

---

### SI-03.10 — Endpoints de leitura e entrega (detalhes + streaming + download)

**Description:** Expor detalhes/status do vídeo e emitir presigned GET URLs para streaming e download direto do storage, sem trafegar bytes pela API.

**Route:** GET /videos/:publicId · GET /videos/:publicId/playback-url · GET /videos/:publicId/download-url
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`
**Authorization:** Anonymous se `ready`, senão Owner — per `## Technical Specifications → Authorization Matrix`

**Technical actions:**

1. Implementar `VideosService.getDetails` — retorna status/metadados; inclui `thumbnailUrl` (presigned GET) só quando `ready`; aplica a regra de visibilidade (não-`ready` só para o dono, senão `FORBIDDEN_VIDEO_ACCESS`) (`phase-03-videos/TD-08`).
2. Implementar `VideosService.getPlaybackUrl` e `getDownloadUrl` — presigned GET de 1h; `download` usa content-disposition attachment; ambos exigem `ready` senão `VIDEO_NOT_READY` (`phase-03-videos/TD-08`).
3. Criar a exceção `VideoNotReadyException` (`409 VIDEO_NOT_READY`) mapeada no filtro herdado.
4. Adicionar `GET /videos/:publicId`, `GET /videos/:publicId/playback-url`, `GET /videos/:publicId/download-url` ao controller (guard JWT opcional para `ready`); respostas per `## Technical Specifications → API Contracts`.
5. Adicionar decorators OpenAPI aos três endpoints (`openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDetails` | Unit: `thumbnailUrl` presente só em `ready`; não-`ready` para não-dono lança `FORBIDDEN_VIDEO_ACCESS` (mock repo + storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl`/`getDownloadUrl` | Unit: exige `ready` (senão `VIDEO_NOT_READY`); download marca attachment | `src/videos/videos.service.spec.ts` |

_E2E dos endpoints são autorados externamente via `/plan-test-specs` (ver `**Test Specs:**`)._

**Dependencies:** SI-03.2 (entidade Video) + SI-03.3 (presigned GET)

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com metadados e `thumbnailUrl` presente.
- `GET /videos/:publicId` de um vídeo não-`ready` por quem não é o dono retorna `403 FORBIDDEN_VIDEO_ACCESS`.
- `GET /videos/:publicId/playback-url` de um vídeo `ready` retorna `200` com `url` presigned e `expiresIn: 3600`.
- `GET /videos/:publicId/playback-url` (ou `/download-url`) de um vídeo não-`ready` retorna `409 VIDEO_NOT_READY`.
- `GET /videos/:publicId` de um `publicId` inexistente retorna `404 VIDEO_NOT_FOUND`.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Pertence a um `Channel` (herdado de `phase-02-auth`). Chaves de objeto persistidas na linha (não URLs completas) para manter bucket/endpoint intercambiáveis entre MinIO e S3 (`phase-03-videos/TD-03`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(11) | unique, not null — identificador de URL nanoid, 11 chars (`phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade |
| title | varchar(255) | nullable — informado no início do upload; edição plena é da Fase 04 |
| status | video_status (enum) | not null, default `draft` — `draft \| processing \| ready \| failed` (`phase-03-videos/TD-09`) |
| storage_key | varchar(1024) | not null — object key do original (`phase-03-videos/TD-03`) |
| thumbnail_key | varchar(1024) | nullable — object key da thumbnail gerada; preenchido ao atingir `ready` (`phase-03-videos/TD-03`, `phase-03-videos/TD-06`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; limpo após conclusão verificada (`phase-03-videos/TD-02`) |
| duration_seconds | int | nullable — extraído por ffprobe (`phase-03-videos/TD-06`) |
| width | int | nullable — extraído por ffprobe |
| height | int | nullable — extraído por ffprobe |
| video_codec | varchar(64) | nullable — extraído por ffprobe |
| audio_codec | varchar(64) | nullable — extraído por ffprobe |
| size_bytes | bigint | nullable — tamanho do original |
| failure_reason | text | nullable — preenchido quando `status = failed` (`phase-03-videos/TD-09`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one, FK `channel_id`).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (usado pela varredura de reconciliação de rascunhos obsoletos — `phase-03-videos/TD-04`).
**Enum `video_status`:** `draft`, `processing`, `ready`, `failed`. Estado inicial `draft` no pré-cadastro; transição `draft → processing` no callback de conclusão verificado (`phase-03-videos/TD-04`); `processing → ready | failed` pelo worker (`phase-03-videos/TD-09`). O estado intermediário `uploading` foi removido — a linha permanece `draft` durante todo o upload direto-ao-storage.

### API Contracts

Todos os endpoints ficam no `nestjs-project` (subproject `nestjs-api`), prefixo de recurso plural `/videos`. Os bytes do vídeo **nunca** trafegam pela API: o upload vai direto browser→storage via presigned multipart (`phase-03-videos/TD-02`) e a entrega vai direto storage→browser via presigned GET (`phase-03-videos/TD-08`). Erros seguem o formato de envelope de domínio herdado (`phase-02-auth/TD-07`: `{ statusCode, error, message }`). Autenticação via guard JWT herdado (`phase-02-auth`).

#### POST /videos (SI-03.4)

Inicia o upload: cria o vídeo em `draft`, gera `public_id`, executa `CreateMultipartUpload` no storage e devolve as URLs presigned de `UploadPart` (uma por parte de 50MiB, expiram em 12h — `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- title: string, optional — título inicial do rascunho
- filename: string, required — nome do arquivo original
- sizeBytes: integer, required — tamanho total do arquivo (usado para calcular a contagem de partes)
- contentType: string, required — MIME informado pelo cliente (validação autoritativa é do ffprobe no worker — `phase-03-videos/TD-06`)

**Response 201:**
- publicId: string (11 chars)
- uploadId: string — S3 multipart UploadId
- key: string — object key do original
- partSize: integer — `52428800` (50MiB)
- parts: array of `{ partNumber: integer, url: string }` — URLs presigned de UploadPart

**Error responses:**
- 401 UNAUTHORIZED: requisição sem sessão válida
- 400 validation error: quando o body falha na validação de schema

---

#### POST /videos/:publicId/complete (SI-03.5)

Finaliza o upload: executa `CompleteMultipartUpload`, verifica o objeto com `HeadObject` (existência + tamanho), transiciona `draft → processing` e enfileira o job de processamento (`phase-03-videos/TD-04`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- parts: array of `{ partNumber: integer, etag: string }`, required — ETags retornados pelo storage em cada UploadPart

**Response 200:**
- publicId: string
- status: string — `processing`

**Error responses:**
- 401 UNAUTHORIZED: sem sessão válida
- 403 FORBIDDEN_VIDEO_ACCESS: autenticado mas não é dono do canal do vídeo
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 INVALID_UPLOAD_STATE: vídeo cujo `status` ≠ `draft`
- 422 UPLOAD_VERIFICATION_FAILED: `HeadObject` não confirma objeto ou tamanho
- 400 validation error: body inválido

---

#### GET /videos/:publicId (SI-03.10)

Detalhes e status do vídeo (usado para polling de status pelo dono e para leitura pública quando `ready`).

**Request headers:**
- Authorization: Bearer {accessToken} — obrigatório apenas para acessar vídeo não-`ready`; opcional para vídeo `ready`

**Response 200:**
- publicId: string
- title: string | null
- status: string — `draft | processing | ready | failed`
- durationSeconds: integer | null
- width: integer | null
- height: integer | null
- thumbnailUrl: string | null — presigned GET da thumbnail, presente apenas quando `status = ready` e `thumbnail_key` existe
- failureReason: string | null — presente apenas quando `status = failed`
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 403 FORBIDDEN_VIDEO_ACCESS: vídeo não-`ready` acessado por quem não é o dono

---

#### GET /videos/:publicId/playback-url (SI-03.10)

Emite uma presigned GET URL para streaming direto do storage (Range/`206` nativo; expira em 1h — `phase-03-videos/TD-08`). Somente para vídeo `ready`.

**Request headers:**
- Authorization: Bearer {accessToken} — opcional (vídeo `ready` é público)

**Response 200:**
- url: string — presigned GET URL
- expiresIn: integer — `3600` (segundos)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_NOT_READY: vídeo cujo `status` ≠ `ready`

---

#### GET /videos/:publicId/download-url (SI-03.10)

Emite uma presigned GET URL com `response-content-disposition=attachment` para download do original (expira em 1h — `phase-03-videos/TD-08`). Somente para vídeo `ready`.

**Request headers:**
- Authorization: Bearer {accessToken} — opcional (vídeo `ready` é público)

**Response 200:**
- url: string — presigned GET URL (forçando download via content-disposition)
- expiresIn: integer — `3600` (segundos)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_NOT_READY: vídeo cujo `status` ≠ `ready`

#### Validation Rules — /videos

- `filename`: obrigatório, string não-vazia
- `sizeBytes`: obrigatório, inteiro positivo, ≤ `10 * 1024 * 1024 * 1024` (10GB)
- `contentType`: obrigatório, string não-vazia (não é allowlist — validação real é do ffprobe no worker, `phase-03-videos/TD-06`)
- `parts`: obrigatório, array não-vazio; cada item `{ partNumber: inteiro ≥ 1, etag: string não-vazia }`

### Authorization Matrix

"Owner" = usuário autenticado dono do canal (`channel_id`) ao qual o vídeo pertence. A verificação de propriedade acontece no service (não apenas no guard). Vídeos não-`ready` só são visíveis ao owner; vídeos `ready` seguem o modelo de visualização anônima do plano.

| Endpoint | Anonymous | Authenticated (não-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ só se `ready` | ✓ só se `ready` | ✓ (qualquer status) |
| GET /videos/:publicId/playback-url | ✓ só se `ready` | ✓ só se `ready` | ✓ só se `ready` |
| GET /videos/:publicId/download-url | ✓ só se `ready` | ✓ só se `ready` | ✓ só se `ready` |

### Error Catalog

Reutiliza o filtro de exceção de domínio e o envelope `{ statusCode, error, message }` estabelecidos em `phase-02-auth/TD-07` (herdado via `## Inherited Conventions`). Novos códigos de domínio desta fase:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` não corresponde a nenhum vídeo |
| FORBIDDEN_VIDEO_ACCESS | 403 | usuário autenticado não é dono do canal do vídeo (ação de owner ou leitura de vídeo não-`ready`) |
| INVALID_UPLOAD_STATE | 409 | `complete` chamado para vídeo cujo `status` ≠ `draft` |
| UPLOAD_VERIFICATION_FAILED | 422 | `HeadObject` não confirma existência/tamanho do objeto após `CompleteMultipartUpload` |
| VIDEO_NOT_READY | 409 | `playback-url`/`download-url` solicitado para vídeo cujo `status` ≠ `ready` |

**Falha de processamento (não é erro HTTP):** quando o worker esgota as tentativas do BullMQ ou o ffprobe não encontra stream de vídeo, o vídeo entra em `status = failed` com `failure_reason` preenchido (`phase-03-videos/TD-09`, `phase-03-videos/TD-06`); o cliente observa isso via `GET /videos/:publicId` (campo `failureReason`), não via resposta de erro.

### Events/Messages

Fila BullMQ sobre Redis (`phase-03-videos/TD-01`), consumida por um container de worker dedicado (`phase-03-videos/TD-05`). O status no banco é a fonte de verdade; os retries nativos do BullMQ cobrem falhas transitórias e um estado terminal `failed` garante que nada fique preso em `processing` (`phase-03-videos/TD-09`).

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` no endpoint `POST /videos/:publicId/complete` — enfileira após a transição `draft → processing` (`phase-03-videos/TD-04`).
**Consumer:** `VideoProcessingProcessor` no container de worker dedicado (`phase-03-videos/TD-05`).
**Trigger:** conclusão de upload verificada (callback do cliente + `HeadObject`).
**Processing steps (`phase-03-videos/TD-06`):** ffprobe (`-show_format -show_streams -print_format json`) para duração/dimensões/codecs → extração de thumbnail do frame a 10% da duração (`ffmpeg -ss <t> -frames:v 1`) → upload da thumbnail para o storage (`thumbnail_key`) → `UPDATE` da linha `videos` com metadados e `status = ready`. Fonte sem stream de vídeo → `failed` permanente.
**Retry/backoff:** `attempts` limitado + backoff exponencial (`phase-03-videos/TD-01`); ao esgotar, o handler de falha grava `status = failed` + `failure_reason` (`phase-03-videos/TD-09`).
**Delivery semantics:** at-least-once — o processor deve ser idempotente, chaveado por `videoId` (transições idempotentes por id do vídeo).

#### video.reconcile-stale-uploads

**Payload:**

```json
{}
```

**Producer:** job repetível (repeatable) agendado na fila (`phase-03-videos/TD-01` scheduling).
**Consumer:** mesmo container de worker.
**Trigger:** periódico (varredura de reconciliação).
**Action (`phase-03-videos/TD-04`):** localiza vídeos em `draft` com `created_at` além do TTL de 24h → executa `AbortMultipartUpload` no storage (usando `upload_id`) e marca a linha como obsoleta, cobrindo o cenário de abandono do cliente.
**Delivery semantics:** best-effort — a varredura é idempotente (reprocessar um rascunho já reclamado é no-op).

---

## Dependency Map

```
SI-03.1 (root — infra MinIO/Redis + configs)
├── SI-03.3 — depends on SI-03.1 (StorageService usa storageConfig + MinIO)
└── SI-03.6 — depends on SI-03.1 + SI-03.2 (fila usa redisConfig; worker carrega o módulo)

SI-03.2 (root — entidade Video + migration)
├── SI-03.4 — depends on SI-03.2 + SI-03.3 (endpoint de início: entidade + storage)
│   └── SI-03.5 — depends on SI-03.4 + SI-03.6 (conclusão: endpoint anterior + fila)
├── SI-03.10 — depends on SI-03.2 + SI-03.3 (endpoints de leitura/entrega)
├── SI-03.8 — depends on SI-03.6 + SI-03.7 + SI-03.3 + SI-03.2 (processor)
└── SI-03.9 — depends on SI-03.6 + SI-03.3 + SI-03.2 (varredura de reconciliação)

SI-03.6 (fila + worker)
└── SI-03.7 — depends on SI-03.6 (FFmpegService roda no worker)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: serviços MinIO + Redis e configs
- [ ] SI-03.2 — Entidade Video + migration + VideosModule
- [ ] SI-03.3 — StorageService (adaptador S3/MinIO)
- [ ] SI-03.4 — Endpoint POST /videos (início do upload)
- [ ] SI-03.5 — Endpoint POST /videos/:publicId/complete (conclusão + enfileiramento)
- [ ] SI-03.6 — Infra: fila BullMQ + container de worker dedicado
- [ ] SI-03.7 — FFmpegService (ffprobe + thumbnail)
- [ ] SI-03.8 — Processor do job video.process
- [ ] SI-03.9 — Varredura de reconciliação de uploads obsoletos
- [ ] SI-03.10 — Endpoints de leitura e entrega (detalhes + streaming + download)

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
