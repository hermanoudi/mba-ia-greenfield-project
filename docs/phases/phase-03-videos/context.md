---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-11T16:25:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-09T15:01:40-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-11T16:25:06-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-11T16:25:06-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-11T16:25:06-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-11T16:25:06-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-11T16:25:05-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ (Per the decisions doc, the video **player** and the visualization page belong to Fase 05; this phase's frontend participation is limited to exercising the cross-layer TD contracts.)
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** `nestjs-project/` (backend: upload orchestration, queue, dedicated video worker, unique-URL, delivery). `next-frontend/` participates only through Cross-layer TD contracts (TD-02/04/07/08) — no frontend-only decision in this phase. Infra: MinIO + Redis added as Compose services.
**Deferred subprojects:** _None._
**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue / Background Job Technology | decided | A (Redis) | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Strategy (up to 10GB) | decided | A (S3 Presigned Multipart) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Layout & Access | decided | A (single bucket, prefixed keys) | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Upload-Completion Trigger → Processing Enqueue | decided | A (client callback + HeadObject verification) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Runtime | decided | A (dedicated worker container) | — |
| phase-03-videos/TD-06 | phase | Backend | FFmpeg / ffprobe Integration | decided | A (direct child_process spawn) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Unique Video URL Identifier | decided | A (nanoid in dedicated public_id column) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming & Download Delivery | decided | A (presigned GET, direct-from-storage) | — |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle & Failure Handling | decided | A (DB enum + queue-native retries + terminal failed) | — |

_`Renders in` column omitted: no TD in scope sets the field (all `—`)._

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** video processing is precisely the long-running, concurrency-sensitive workload BullMQ is built for; native concurrency limits and exponential-backoff retries directly serve TD-09's failure handling, and the official `@nestjs/bullmq` module keeps the worker inside the same DI/testing conventions as the rest of the backend. The cost is one Redis container in Compose — a low, well-understood addition. If the team prioritizes infra-minimalism over throughput/tooling, **Option B (pg-boss)** is the honest runner-up: it adds nothing to the stack and gives transactional enqueue with the `videos` row, at the price of a hand-rolled NestJS integration.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** it is the only option that simultaneously satisfies the 10GB ceiling (single-PUT caps at 5GB), keeps all bytes off the API tier, and delivers resumability/parallelism via native S3/MinIO features with no extra protocol server. Depends on TD-03 (key layout) for where parts land and TD-04 for how completion is confirmed.
**Libraries:** —

**Revisions:**
- 2026-07-09 — Confirmed during phase-plan validation: multipart part size fixed at 50MiB (within the "≥5MB except the last" constraint) and presigned `UploadPart` URL expiry set to 12h. Rationale: 50MiB parts keep the part count manageable for a 10GB file (~200 parts) while staying well above the 5MB floor; a 12h expiry gives slow or interrupted uploads a generous window to complete without re-issuing URLs.

### phase-03-videos/TD-03

**Recommendation:** keeps provisioning trivial (matches the single-instance Docker setup), gives clean per-channel/per-video organization and cleanup, and keeps all objects private with access granted exclusively through presigned URLs (TD-02 for upload, TD-08 for delivery). Persist the object keys (not full URLs) on the `videos` row so the bucket/endpoint stays swappable between MinIO and S3.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** deterministic, gives the user immediate status feedback, and works identically on MinIO and S3 with no event-bus wiring. Pair it with a background reconciliation job (using the TD-01 queue's scheduling) that aborts multipart uploads and marks `uploading` videos stale after a TTL, covering the client-drop-off gap that is Option B's only real advantage. Depends on TD-01 (enqueue) and TD-02 (upload flow).
**Libraries:** —

**Revisions:**
- 2026-07-09 — Completion transition and the stale-upload sweep operate on the `draft` state, not a separate `uploading` state (aligns with TD-09's simplified lifecycle): the verified completion callback moves `draft → processing`, and the reconciliation sweep reclaims videos left in `draft` past the TTL. Stale-upload sweep TTL confirmed at 24h during phase-plan validation. Rationale: the `uploading` state was removed from the lifecycle (see TD-09 revision); the sweep therefore targets stale `draft` rows.

### phase-03-videos/TD-05

**Recommendation:** it is the architecture already committed to in the diagram and the only option that isolates heavy FFmpeg work from API responsiveness while allowing independent scaling and a lean API image. In dev it is one more Compose service consuming the TD-01 queue.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** the ffprobe/ffmpeg CLI surface needed here is small and stable (one metadata probe, one frame grab), so a thin internal helper avoids taking on an unmaintained dependency for marginal ergonomic gain. Wrap the spawn calls in a small typed service with explicit timeouts and stderr capture to feed TD-09's failure handling.
**Libraries:** —

**Revisions:**
- 2026-07-09 — Confirmed during phase-plan validation: the thumbnail is captured from the frame at 10% of the video duration, and accepted upload formats are unrestricted (any file) with ffprobe as the authoritative validation — a source with no video stream drives a permanent `failed` (TD-09). Rationale: 10% avoids black intro frames while staying representative; deferring format validation to ffprobe removes a brittle client-side allowlist and centralizes the check where the real inspection already happens.

### phase-03-videos/TD-07

**Recommendation:** delivers the short, unique, unguessable URL the plan explicitly wants while preserving the UUID-PK entity convention. The unique constraint plus regenerate-on-collision makes conflicts a non-issue. The frontend routes purely on `public_id`.
**Libraries:** —

**Revisions:**
- 2026-07-09 — `public_id` length fixed at 11 characters (nanoid), narrowing the original "11–12" range. Rationale: 11 chars matches the YouTube-style identifier length and keeps collision probability negligible at this scale, backed by the unique constraint + regenerate-on-conflict guard already decided.

### phase-03-videos/TD-08

**Recommendation:** it keeps bytes off the API tier (consistent with TD-02), gets Range/`206` streaming for free from MinIO/S3, and covers download via a `content-disposition` variant of the same presigned URL. Authorization is enforced at issuance (checking visibility rules), which suffices for the anonymous-viewing model. A CDN (Option C) can later wrap this without changing the contract. Depends on TD-03 (object keys).
**Libraries:** —

**Revisions:**
- 2026-07-09 — Presigned GET URL expiry for both playback and download confirmed at 1h during phase-plan validation. Rationale: 1h covers a normal viewing/download session while keeping the short-lived exposure window the direct-from-storage model relies on; longer sessions refresh the URL via a new request.

### phase-03-videos/TD-09

**Recommendation:** keeps a single queryable source of truth the whole system already reads, leans on BullMQ's built-in bounded retries/backoff (TD-01) for transient failures, and guarantees a terminal `failed` state so nothing hangs in "processing". Transitions are written from the worker's job completion/failure handlers, with the DB row authoritative. Depends on TD-01 (retry/backoff) and TD-04 (draft creation / enqueue point).
**Libraries:** —

**Revisions:**
- 2026-07-09 — Lifecycle enum simplified to `draft → processing → ready | failed`; the intermediate `uploading` state was dropped. The row stays `draft` throughout the direct-to-storage upload and transitions straight to `processing` on the verified completion callback (TD-04). Rationale: with bytes going browser→storage (TD-02), the API never observes a distinct `uploading` phase separate from `draft`; a single pre-upload state removes a redundant transition and matches the implemented status enum in the phase plan (SI-03.6, Data Model).

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01
**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02
**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03
**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04
**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01
**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02
**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03
**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04
**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05
**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06
**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07
**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08
**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09
**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10
**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01
**Recommendation:** (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 tracks Next.js majors with a lag. Option C rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02
**Recommendation:** (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout and avoids the orphan-cookie failure mode. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render authenticated chrome without a per-render `/auth/me` round-trip. Option A is a viable downgrade; A→B/B→A is a one-Route-Handler refactor. Option C rejected: solves server-side revocation the project does not need.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03
**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04
**Recommendation:** (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; form code does not change if TD-05 is revisited. (2) **Aligned with shadcn's canonical form primitive** — the project commits to `radix-nova` shadcn; `npx shadcn add form` produces react-hook-form wrappers. (3) **Zod-first ergonomics match the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; same schemas-as-source-of-truth carries to forms. Option B rejected for impedance with shadcn's primitive; Option C for per-field boilerplate.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05
**Recommendation:** (1) **Strict-BFF alignment.** Route Handlers were named as the BFF surface; keeps every mutation under `app/api/**`. (2) **Test scaffold already exists** for Route-Handlers-as-functions; reuses it with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking. Option B fragments the BFF surface; migration A→B is per-form if progressive enhancement is later wanted.
**Libraries:** —

### phase-02-auth-frontend/TD-06
**Recommendation:** (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with correct initial state. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it. The `router.refresh()` after mid-session mutations is a one-line price. Option B rejected for double-read-and-flicker; Option C dominated.
**Libraries:** —

### phase-02-auth-frontend/TD-07
**Recommendation:** (1) **First-paint-correct** — the user sees the right outcome on first paint, no skeleton. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form; both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level. Option B adds redirects for no clean gain; Option C dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01
**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02
**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03
**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: {...} })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. Known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Umbrella bullet's full coverage requires the confirmação and reset-password destination screens, both deferred. The 3 ship-this-phase telas (signup, login, forgot-password) are covered; umbrella deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, queue) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller (`*.controller.ts`) | E2E only — no unit tests |
| DTO (`*.dto.ts`) | E2E: one validation wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transform/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Test suffixes (project convention): `*.spec.ts` (unit), `*.integration-spec.ts` (integration, real DB/services), `*.e2e-spec.ts` (E2E via supertest). "E2E" here = HTTP-layer integration via supertest, not browser-based._
