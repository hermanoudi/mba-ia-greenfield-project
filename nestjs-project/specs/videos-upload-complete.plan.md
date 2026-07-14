---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/complete (conclusão do upload) — Test Plan

## Application Overview

Endpoint que finaliza o upload direto-ao-storage: completa o multipart no storage, verifica o objeto com `HeadObject` (existência + tamanho), transiciona o vídeo de `draft` para `processing` e enfileira o job de processamento. Apenas o dono do canal do vídeo pode chamá-lo.

## Test Scenarios

### 1. Conclusão de upload

**Setup:** `beforeEach` trunca as tabelas do banco de teste; bootstrap do módulo Nest; cria um dono autenticado com canal e um vídeo em `status = draft` com `upload_id` conhecido; a fila BullMQ pode ser inspecionada (fila de teste) ou o producer espionado; o StorageService de teste confirma/nega o `HeadObject` conforme o cenário.

#### 1.1. dono-com-objeto-presente-retorna-200-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos/:publicId/complete como dono, com `parts` válidas, storage confirmando o objeto no `HeadObject`
    - expect: status 200
    - expect: body `{ publicId, status: "processing" }`
    - expect: a linha `videos` fica em `status = "processing"` e um job `video.process` é enfileirado com o `videoId`

#### 1.2. status-diferente-de-draft-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos/:publicId/complete como dono para um vídeo já em `processing`
    - expect: status 409
    - expect: body `error` = `INVALID_UPLOAD_STATE`

#### 1.3. headobject-nao-confirma-retorna-422

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos/:publicId/complete como dono, com o storage negando o `HeadObject` (objeto ausente ou tamanho divergente)
    - expect: status 422
    - expect: body `error` = `UPLOAD_VERIFICATION_FAILED`
    - expect: a linha `videos` permanece em `draft` (não transiciona)

#### 1.4. nao-dono-retorna-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. POST /videos/:publicId/complete autenticado como um usuário que não é dono do canal do vídeo
    - expect: status 403
    - expect: body `error` = `FORBIDDEN_VIDEO_ACCESS`
