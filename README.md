# Agent Benchmarks

Self-hosted, single-owner journal for agent work. Posts hold the original prompt, references, a final showcase, ordered progress images/videos and manually recorded runs. The interface uses black, white and neutral grays.

## Run locally

Install Node 24 LTS (24.14 or newer) and FFmpeg/ffprobe on PATH. FFmpeg is needed for MP4 uploads; the Docker image includes it.

```sh
npm ci
cp .env.example .env
npm run build
npm run admin:password
npm start
```

On PowerShell use `Copy-Item .env.example .env` in place of `cp`. The default address is **http://localhost:8787**. Choose your own password in a private terminal; the helper hides input and saves a scrypt hash in the ignored `.env`. No password is supplied by this project. Restart after changing it. Leaving the hash blank disables administration.

For the existing live route, set `PUBLIC_URL=https://bench.arkiental.com`. Port remains **8787**. The application accepts only that host and origin. Use the public URL in your browser; a localhost request with a different host is intentionally rejected. `/healthz` remains available locally. Do not disable host or CSRF checks to fix an origin mismatch.

Optional examples: `npm run seed:demo`. These are labeled generated artwork, with no fabricated model or benchmark measurements. A fresh installation starts empty.

## Docker

Configure `.env` and your owner password first, then:

```sh
docker compose up -d --build
docker compose ps
```

The published port is `127.0.0.1:8787`. Stop the Node preview before starting Docker on that same port. The app runs as a non-root user with a read-only root filesystem. Database and uploads live in the `journal_data` volume under `/app/storage/data`; backups go to `./backups`. On Linux, create that directory and make it writable by container UID 1000 before use. Never run `docker compose down -v` against data you want to retain.

Docker-only password setup can use the image's hidden interactive helper with your project directory mounted at `/configuration` and the working directory set there:

```sh
docker compose build
docker run --rm -it --mount type=bind,source=<absolute-project-directory>,target=/configuration --workdir /configuration agent-benchmarks:local node /app/dist/scripts/password.js
```

On Linux, add `--user <your-uid>:<your-gid>` if needed to write your own configuration. The helper changes only `.env`; do not put a password or hash in a command argument or Git commit.

## Posting and media

Use `/admin` to create, edit, publish, unpublish and delete posts. A still cover is required for publication. Final and progress galleries each support up to 50 items. Drag files onto their upload areas; uploads run sequentially. Reorder with drag handles or the keyboard-accessible Earlier/Later buttons. Removing an attachment keeps its file in Media; files used in posts cannot be deleted there.

Images: PNG/JPEG/WebP, default 12 MB, decoded and re-encoded without source metadata, at most 40 million source pixels. MP4: default 100 MB, H.264 with optional AAC audio, at most 4K per dimension and four hours. MP4s are probed, stripped of source metadata, remuxed for streaming, and given a still thumbnail. Videos play on demand with native controls. The media route supports byte ranges. Upload processing has a two-file concurrency cap, rate limits and a total storage quota (default 2 GB).

Run fields include provider, model, reasoning effort, elapsed seconds, total tokens, estimated USD cost, outcome and conditions. Provider choices are OpenAI, Google, Anthropic and Other with a custom name. Model and reasoning effort accept free text. Values are authored; unknown metadata remains blank. Journal search updates while typing, with provider/model/reasoning filters drawn from recorded published values. Combined run filters match the same run.

References appear beneath the prompt in their recorded order. Attach up to 50 uploaded images/MP4s or HTTP(S) links; use drag handles or Earlier/Later to reorder. Visitors can download each processed file or a prompt-and-references ZIP containing `prompt.txt`, ordered `references.json` and attached media. External URLs are recorded in the manifest and never fetched by the server. ZIP downloads stream, with a 200 MiB total cap, two concurrent downloads and a per-IP rate limit. Larger sets remain individually downloadable. Processed media has stripped source metadata; the original upload bytes are not retained.

In Admin → Groups, associate up to 20 whole posts. Provider/model tabs switch complete post content using normal browser history and shareable post URLs. Draft members remain private. The group's owner toggle controls side-by-side comparison; when enabled, visitors can select up to eight whole posts, with responsive columns for four or more providers. There are no public submissions, accounts or invented community statistics.

Prompts support 100,000 characters. Long prompts collapse, expand, copy and download without altering the original. Published post HTML includes escaped OG/Twitter metadata with a bounded description and cover image; it includes recorded metrics when present and never embeds the full prompt. Draft metadata and draft-only media return 404 to visitors. Share previews already cached by third-party services cannot be revoked by this application.

## Agent authoring

The stable `/api/v1` API and local `npm run agent -- ...` CLI support full post metadata, galleries, references, uploads and comparison groups. See [authoring instructions](docs/authoring.md), [machine-readable schema](docs/authoring.schema.json) and [draft example](docs/examples/draft.json). The CLI reads only files explicitly named in its arguments.

Agent credentials are disabled until the owner creates one in Admin → Agent tokens. No token is generated during installation, migration or startup. The owner chooses scopes and an expiry, copies the one-time secret privately, and can revoke it. Only a SHA-256 digest is stored. Draft authoring and publication use separate scopes; modifying an already published post or a group with published members requires `publish`. Browser administration retains session, origin and CSRF checks. Agent writes require a bearer credential and an idempotency key; reusing a key for another request returns 409. Updates require the current revision. Tokens belong in the caller's private environment, never source files, command arguments or logs.

## Configuration and reverse proxy

Anonymous API traffic is limited to 240 requests per minute per trusted client address. Valid owner sessions and agent credentials each have a separate 600-request bucket, so bulk editing does not consume the visitor quota. Login, upload and bundle limits still apply independently. Forged cookies or bearer headers cannot obtain an authenticated bucket.

`.env.example` documents the configurable origin, port, data directory, site name, session lifetime, image/video limits, storage quota and indexing. `PUBLIC_URL` must be a bare origin; use HTTPS outside localhost. Secure owner cookies are selected from this configured origin. Owner writes require that origin plus a session-specific CSRF token. Sessions are persisted and revoked on logout or password change.

Keep the origin service bound to loopback. An existing Cloudflare Tunnel or reverse proxy should forward to `http://127.0.0.1:8787` and preserve the `bench.arkiental.com` Host header. If using a different deployment, choose its origin in `.env` first. `TRUSTED_PROXY_CIDRS` is blank by default, so forwarded headers are ignored. Set only the exact proxy IPs or narrow CIDRs you control; never trust every source. Indexing stays disabled until `ALLOW_INDEXING=true`.

This repository does not create DNS records, tunnel credentials, public tunnels, email, analytics or payment integrations. See [Cloudflare origin settings](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/origin-configuration/) for an existing tunnel's host settings.

## Backup, restore and upgrades

Stop the app before maintenance. `--stopped` is your acknowledgment; it is not a process lock. This keeps the database and files consistent. Backups include all cataloged media, verified SHA-256 hashes, schema version and counts; owner sessions, agent credentials and replay records are removed. Copy verified snapshots off the host yourself.

```sh
# Node: stop npm start first
npm run backup -- backups --stopped
npm run restore -- backups/<snapshot-directory> --stopped
npm start
```

```sh
docker compose stop journal
docker compose run --rm --no-deps journal node dist/scripts/backup.js /app/backups --stopped
# To restore, while still stopped:
docker compose run --rm --no-deps journal node dist/scripts/restore.js /app/backups/<snapshot-directory> --stopped
docker compose up -d journal
```

Restore verifies the entire snapshot before changing the target and retains prior data in a sibling `data.before-restore-*` directory. Confirm the restored journal before manually removing that retained copy. `.env` is intentionally excluded; back up configuration separately in a secure location. Sign in again after restoration and explicitly issue any replacement agent credentials.

SQLite migrations run transactionally on startup. Schema version 2 adds video types, galleries and optional run metrics. Version 3 adds references, provider metadata, comparison groups and scoped agent authoring while preserving previous content. Legacy providers remain unrecorded. Older snapshots are accepted and migrated on startup. A database from a newer unsupported version is refused. Back up before upgrading, stop the app, rebuild, then start it. Keep the previous image/source and backup for rollback.

## Verification

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
docker build -t agent-benchmarks:local .
npm run test:docker
```

Browser tests use isolated data on port 8788 and a fixture-only password. They cover a 50-file drag/drop upload, separate final/progress galleries, ordering, MP4 playback, long prompt preservation/download, sharing, owner CRUD, comparisons, errors, mobile overflow and automated accessibility. API tests cover authorization, origin/CSRF/host checks, rate limits, uploads, publication privacy, concurrency revisions, metadata and backup/migration integrity. Docker smoke tests create and remove only uniquely labeled disposable fixtures and verify restoration across container replacement.

On Windows, `PLAYWRIGHT_CHANNEL=msedge` selects an installed headless Edge browser (set `$env:PLAYWRIGHT_CHANNEL='msedge'` in PowerShell). If the local sandbox restricts Playwright child-process cleanup, start the isolated fixture separately and set `BROWSER_TEST_EXTERNAL=1`; stop that fixture after testing. The production server is not used by these tests.

GitHub CI builds, runs API/browser tests and checks Docker persistence/restoration. It has read-only repository permissions and no deployment step.
