---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos-upload-init.e2e-spec.ts
---

# POST /videos (início do upload) — Test Plan

## Application Overview

Endpoint autenticado que inicia o upload de um vídeo: pré-cadastra a linha `videos` em `status = draft` com um `public_id` nanoid de 11 caracteres, abre um multipart no object storage e devolve as URLs presigned de `UploadPart` para o cliente enviar as partes direto ao storage. Os bytes nunca passam pela API.

## Test Scenarios

### 1. Início de upload

**Setup:** `beforeEach` trunca as tabelas `videos`/`channels`/`users` do banco de teste; bootstrap do módulo Nest via `Test.createTestingModule` + `app.init()`; cria um usuário autenticado com canal e obtém um access token; StorageService pode apontar para o MinIO de teste ou ter o multipart-init stubado no nível do adaptador.

#### 1.1. inicio-valido-retorna-201-com-presigned-parts

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos com Authorization Bearer válido e body `{ filename: "clip.mp4", sizeBytes: 104857600, contentType: "video/mp4" }`
    - expect: status 201
    - expect: body contém `publicId` (string de 11 chars), `uploadId`, `key`, `partSize` = 52428800 e `parts` (array não-vazio de `{ partNumber, url }`)
    - expect: existe uma linha `videos` com `status = "draft"` e `public_id` de 11 chars

#### 1.2. sem-sessao-retorna-401

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos sem header Authorization, body válido
    - expect: status 401
    - expect: nenhuma linha `videos` é criada

#### 1.3. body-invalido-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos autenticado com `sizeBytes` acima de 10GB (`10737418241`)
    - expect: status 400
  2. POST /videos autenticado sem o campo `filename`
    - expect: status 400
    - expect: nenhuma linha `videos` é criada em nenhum dos dois casos
