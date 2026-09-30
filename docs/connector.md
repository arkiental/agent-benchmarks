# Saved-token benchmark connector

This local Windows MCP server exposes benchmark post search/read, draft creation, revision-checked editing, explicit publication, media listing and uploads from explicitly named files. Post inputs include render collections, final/progress galleries, references and recorded run metadata. It exposes no token creation, credential export, arbitrary HTTP request, shell, database or computer-access tool.

## One-time owner setup

In the signed-in owner page at https://bench.arkiental.com/admin/agents, issue or reuse a valid token with **Read posts**, **Create and edit drafts**, **Upload media** and, for requested publication, **Publish posts**. Comparison-group permission is unnecessary. Choose an expiry of 1–90 days. Existing expiry and revocation stay in force; the connector cannot renew or create credentials.

Run this yourself in a private PowerShell terminal:

```powershell
& 'E:\Codex\agent-benchmarks\scripts\setup-connector.ps1' -AllowPublishing -RegisterCodex
```

Enter the token once at the hidden prompt. The script validates it against the configured site and encrypts it with Windows DPAPI CurrentUser under `%LOCALAPPDATA%\AgentBenchmarks\Connector\credential.dpapi`, outside the repository. The folder permits your Windows account and SYSTEM. No token is placed in command arguments, environment configuration, source, a transcript or MCP tool results. Decrypted material exists in memory and a private child-process pipe while a tool executes; Windows account access remains the trust boundary.

`-RegisterCodex` uses the installed `codex mcp add` command to register `agent_benchmarks` with a Node command and the compiled connector path, without credential arguments. Restart/reconnect that server in the desktop app or start a fresh local Codex session. Call `bench_status` to confirm scopes/expiry. Later calls reuse the same saved token without asking you to paste it again.

The [supported desktop MCP setup](https://developers.openai.com/codex/mcp/) is Settings → MCP servers → Add server → STDIO. If registering manually, use the absolute `node.exe` path printed by setup and argument `E:\Codex\agent-benchmarks\dist\scripts\connector.js`, then Save and Restart. A local MCP client must run under the Windows account that saved the token. A hosted chat/dot does not automatically inherit this local server or CLI: its supported client connection must expose the MCP tools first. This project does not install a hosted plugin, a public MCP endpoint or a tunnel.

Omit `-AllowPublishing` and issue a three-scope token for draft-only access. Default upload folders are `.local\agent-uploads` and the existing prepared BMD3 staging folder, when present. For other folders, choose them explicitly during setup:

```powershell
& .\scripts\setup-connector.ps1 -Replace -AllowPublishing -UploadRoot @('E:\My Renders')
```

The connector accepts one explicit absolute PNG/JPEG/WebP/MP4 path within these approved folders, resolves it to prevent traversal or escaping links, and never scans directories. Server image limits (32 MiB by default), video limits, MIME/content processing, quota and rate handling still apply. Put future approved files into an allowed folder or deliberately rerun setup with a revised list.

## Tools

| Tool | Behavior |
| --- | --- |
| `bench_status`, `bench_schema` | Safe credential metadata and current post schema; no secret. |
| `bench_search_posts`, `bench_get_post` | Authorized summaries including drafts, or a complete record and revision. Search is bounded to 1,200 scanned posts and at most 60 returned results. |
| `bench_create_draft` | Schema-valid draft creation with an explicit stable idempotency key. |
| `bench_update_post` | Full replacement using the current revision, preserving unrelated fields. Published edits require `confirmPublishedChange` and enabled publish scope. |
| `bench_publish_post` | Separate publication operation for an explicitly requested post, with revision and idempotency key. |
| `bench_list_media`, `bench_upload_media` | Authorized catalog and exactly one owner-approved local file per upload. |

Fetch a full post before editing. Preserve its prompt, statistics, collections and other galleries, strip response-only fields using `bench_schema`, and submit the fetched revision. Reuse the same idempotency key for an identical write retry within the API's 24-hour replay window. A different request or stale revision returns 409; stop and refetch. After an uncertain upload, do not blindly create a new key or repeat beyond the replay window.

Setup checks scopes and expiry; each API operation still checks the real token's scope, expiry and revocation. Remove access in the owner Agent tokens page. To forget only the local encrypted copy:

```powershell
& .\scripts\setup-connector.ps1 -Forget
codex mcp remove agent_benchmarks
```

After expiry or deliberate rotation, obtain a replacement yourself and rerun setup with `-Replace`. Neither installation nor server startup activates credentials. Standard output is reserved for MCP JSON; operational failures and upstream responses are bounded and redact agent secrets.
