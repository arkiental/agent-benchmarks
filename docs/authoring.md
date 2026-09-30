# Authoring API and local CLI

The version 1 API creates drafts, edits full posts, uploads explicitly chosen files, and manages comparison groups. It uses the same validation, storage limits, revision checks and media processing as the owner editor. References, final renders, progress and named render collections remain distinct ordered fields. Uploaded images are re-encoded WebP; accepted H.264/AAC MP4 files retain video playback. Reference links are recorded as URLs; the server never fetches them.

## Owner-controlled credentials

Sign in to the owner editor and open **Agent tokens**. Create a named credential, select its scopes and a lifetime of 1–90 days, and copy the secret shown once. No credential is created by installation or startup. The database stores its SHA-256 digest, scope list, expiry and usage timestamps. Up to 20 unexpired credentials can exist. Revoke a credential from the same owner page; further requests are rejected and its replay records are cleared. Backups exclude credentials and sessions, so restoring requires fresh owner-issued credentials.

| Scope | Permission |
| --- | --- |
| `posts:read` | Read full drafts, published posts, comparison groups and owner media. |
| `posts:write` | Create and replace draft posts. |
| `publish` | With the appropriate write scope, publish or change any already published post or group containing published posts. |
| `media:write` | Upload one image or MP4 per request. |
| `groups:write` | Create, replace or delete comparison groups, or change a post's group assignment. |

A practical draft-only agent uses `posts:read`, `posts:write`, `media:write` and optionally `groups:write`. Publication remains owner-controlled unless `publish` is explicitly granted. Browser owner routes still require their session, exact Origin and CSRF token; bearer credentials cannot authenticate those routes.

Set `BENCH_URL` to the configured public origin and `BENCH_TOKEN` in your local environment or secret manager. The CLI never takes a token on its command line or prints it. Use HTTPS for a remote origin; plain HTTP is accepted only for localhost. Do not put credentials in a post, prompt, JSON request file or repository.

```powershell
$env:BENCH_URL = 'https://bench.arkiental.com'
# Set BENCH_TOKEN privately in this terminal or your agent's secret manager.
npm run agent -- whoami
npm run agent -- schema
npm run agent -- media upload .\sample-data\finished.png --key fixture-image-upload-0001
npm run agent -- post create .\docs\examples\draft.json --key fixture-draft-create-0001
```

The sample draft is clearly labeled and uses no real metrics. These commands are examples: do not run them against an existing site unless you intend to author that draft. Automated tests run the same workflow against an isolated temporary database and generated sample image. The CLI reads only the JSON/media file explicitly supplied and writes only a named download path; it does not scan folders or ask the server to open a local path.

## HTTP requests

Use `Authorization: Bearer <owner-issued-secret>` for every authoring route except the public schema. Every POST, PUT and DELETE also requires `Idempotency-Key`: 16–120 ASCII letters, digits, dot, underscore, colon or hyphen. JSON bodies use `Content-Type: application/json`. JSON requests are limited to 512 KiB. All API responses are uncached.

| Method and route | Behavior |
| --- | --- |
| `GET /api/v1/schema` | Machine-readable JSON Schema, also committed as `docs/authoring.schema.json`. |
| `GET /api/v1/me` | This credential's name, scopes, expiry and usage; no secret or digest. |
| `GET /api/v1/posts?status=draft&page=1&limit=24` | Post summaries; status is optional, limit is at most 60. |
| `GET /api/v1/posts/:id` | Full post, including media, references and group metadata. |
| `POST /api/v1/posts` | Create a full post; omit revision. HTTP 201. |
| `PUT /api/v1/posts/:id` | Replace the full post; include its latest revision. HTTP 200. |
| `GET /api/v1/media?page=1&limit=24` | Owner media catalog. |
| `POST /api/v1/media` | Multipart upload: exactly one file in field `image`, including MP4. HTTP 201. |
| `GET /api/v1/media/:id` | Authenticated media bytes, including private/draft media. Video supports Range. |
| `GET /api/v1/media/:id/thumb` | Authenticated WebP thumbnail. |
| `GET /api/v1/groups?page=1&limit=24` | Comparison groups, including draft memberships. |
| `GET /api/v1/groups/:id` | Full comparison group. |
| `POST /api/v1/groups` | Create `{title,allowSideBySide,postIds}`; omit revision. HTTP 201. |
| `PUT /api/v1/groups/:id` | Replace group fields and membership; include latest revision. |
| `DELETE /api/v1/groups/:id` | JSON `{revision}`; detach posts, retain their content. HTTP 204. |

There is no agent token-issuance route and no agent post/media deletion route. Credential creation/revocation requires the signed-in owner UI and its existing CSRF protection.

### Post fields

Use `docs/examples/draft.json` as a starting point. Get an uploaded media ID from the upload response and add it to `coverId`, `showcaseMediaIds`, `collections`, `progress`, run `resultMediaIds`, or media references. A published post requires a still-image cover. Set `status: "draft"` while collecting results. Do not invent elapsed time, tokens or cost: use `null` or omit optional values.

Each run has a free-text `model` and `reasoningEffort`. Provider is `OpenAI`, `Google`, `Anthropic`, `Other`, or `null` when not recorded. `Other` requires a nonempty `customProvider`; other choices require it to be empty. Original prompts allow 100,000 characters. The total JSON request still must fit 512 KiB.

`references` is an ordered array of at most 50 items:

```json
[
  {"kind":"media","mediaId":"00000000-0000-4000-8000-000000000001","label":"Reference image"},
  {"kind":"link","url":"https://example.com/reference","label":"Reference link"}
]
```

Upload a video exactly like an image. A reference URL must be HTTP(S), have no embedded username/password, and be no longer than 2,048 characters. The downloadable prompt/reference ZIP includes a URL manifest and uploaded reference files; it does not fetch web links. Individual file downloads and ZIPs obey the post's publication permissions.

Final showcase and progress each accept at most 50 items. `showcaseMediaIds` is the final ordering. `progress` is ordered `{mediaId,label,elapsedSeconds}`. Run result images accept at most 12 IDs per run. Groups associate up to 20 full posts; `allowSideBySide` controls whether that group permits simultaneous comparison. Changing membership increments affected post revisions; refetch before editing those posts.

### Render collections

`collections` is an optional ordered array of named render groups within a post. These are separate from comparison groups, which associate different posts. A collection uses a stable UUID, a nonempty title of up to 120 characters, and ordered still-image IDs:

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000002",
    "title": "Daylight",
    "mediaIds": ["00000000-0000-4000-8000-000000000001"]
  }
]
```

A post accepts up to 20 collections, 100 unique images per collection and 500 image entries in total. Collection IDs must be unique within the post. Empty collections are allowed while organizing a draft. Array order determines collection and image order. Upload images first, then include their IDs when creating or editing a post. Only existing still images are accepted; MP4s remain in the final or progress galleries. An omitted `collections` field preserves existing collections on edit; send `[]` to remove them. Older posts return `collections: []`. Collections follow the post's publication permissions and share the existing revision/idempotency checks.

Images accept up to 32 MiB by default (`UPLOAD_MAX_MB=32`), including PNG, JPEG and WebP. `/api/site` returns the active `uploadMaxBytes` limit; it applies equally to the owner editor and authenticated API. Decoding remains capped at 40 million pixels, and processing/storage limits remain enforced. Configured image limits may be raised to 64 MiB. The default MP4 limit remains 100 MiB. Any reverse proxy must allow at least the larger active image/video limit plus multipart overhead.

### Revisions and retries

Fetch the current record before editing. Build a request containing only schema input fields, retain its current `revision`, and send PUT. Response-only fields such as `id`, `media`, `group`, timestamps and summary `models`/`providers` are not accepted input. If another editor saved first, HTTP 409 prevents overwriting their changes. Fetch again and merge deliberately.

Successful writes retain an atomic replay record for 24 hours. Retrying the same method, route and body with the same key returns the original response and `Idempotency-Replayed: true`; a different request using that key gets HTTP 409. JSON key order does not matter. Multipart replay compares file bytes, name and MIME, so different content cannot silently reuse a prior upload. A concurrent upload with the same key receives HTTP 409 while processing. Failed uploads release their reservation; interrupted reservations expire after five minutes. There are at most 1,000 replay records per credential in that window. Authentication and required scopes are checked again for each retry.

The CLI accepts `--key` for reliable retries. Without it, the CLI generates and prints a nonsecret UUID key on stderr before the request; preserve that key when retrying after a network interruption. Reusing a key after its 24-hour retention may perform a new write. Pending uploads recheck expiry and revocation before returning their result and remove the new unused media if access expired. Revocation does not undo a write that already completed.

CLI examples:

```powershell
npm run agent -- posts list --status draft
npm run agent -- post get POST_UUID
npm run agent -- post update POST_UUID .\updated-post.json --key deliberate-post-edit-0001
npm run agent -- groups list
npm run agent -- group create .\docs\examples\group.json --key fixture-group-create-0001
npm run agent -- group update GROUP_UUID .\updated-group.json --key deliberate-group-edit-0001
npm run agent -- media download MEDIA_UUID .\downloaded-reference.webp
```

CLI JSON files are limited to 512 KiB, local uploads/downloads to 500 MiB, and downloads refuse to overwrite an existing path. The server's configured image/video/storage limits can be lower. Errors use HTTP 400 for validation, 401 for an absent/expired/revoked credential, 403 for insufficient scope, 409 for revision/idempotency conflict, 413 for request/file size, 415 for unsupported file content, 429 for rate/capacity limits, and 507 for full media storage. Credentials do not bypass any upload validation or rate limits.
