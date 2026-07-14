---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-read.e2e-spec.ts
---

# GET /videos/:publicId + playback-url + download-url (leitura e entrega) — Test Plan

## Application Overview

Endpoints de leitura que expõem detalhes/status do vídeo e emitem presigned GET URLs para streaming e download direto do storage. Vídeos `ready` seguem o modelo de visualização anônima; vídeos não-`ready` só são visíveis ao dono. Nenhum byte de vídeo passa pela API.

## Test Scenarios

### 1. Detalhes do vídeo

**Setup:** `beforeEach` trunca as tabelas do banco de teste; bootstrap do módulo Nest; cria um dono com canal e vídeos em estados variados (`ready` com `thumbnail_key`/metadados, `processing`); o StorageService de teste emite presigned URLs determinísticas.

#### 1.1. ready-retorna-200-com-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. GET /videos/:publicId de um vídeo `ready` (anônimo)
    - expect: status 200
    - expect: body contém `status: "ready"`, `durationSeconds`, `width`, `height` e `thumbnailUrl` presente (presigned)

#### 1.2. nao-ready-por-nao-dono-retorna-403

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. GET /videos/:publicId de um vídeo em `processing` como anônimo (ou autenticado não-dono)
    - expect: status 403
    - expect: body `error` = `FORBIDDEN_VIDEO_ACCESS`

#### 1.3. publicid-inexistente-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. GET /videos/:publicId com um `publicId` que não existe
    - expect: status 404
    - expect: body `error` = `VIDEO_NOT_FOUND`

### 2. URLs de entrega (streaming e download)

**Setup:** herda o setup do Grupo 1.

#### 2.1. playback-url-de-ready-retorna-200

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. GET /videos/:publicId/playback-url de um vídeo `ready`
    - expect: status 200
    - expect: body `{ url: <presigned GET>, expiresIn: 3600 }`

#### 2.2. entrega-de-nao-ready-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-12T01:24:47Z

**Steps:**
  1. GET /videos/:publicId/playback-url de um vídeo em `processing`
    - expect: status 409
    - expect: body `error` = `VIDEO_NOT_READY`
  2. GET /videos/:publicId/download-url do mesmo vídeo não-`ready`
    - expect: status 409
    - expect: body `error` = `VIDEO_NOT_READY`
