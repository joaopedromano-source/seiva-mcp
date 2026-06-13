# `@seiva-ai/mcp-server`

MCP server that lets coding agents in IDEs (Claude Code, Codex, Antigravity, Cursor) operate the Seiva platform — create and edit apps, run tools, manage schedules, inspect logs, push/pull local checkouts, and (Phase 2+) migrate external projects.

There are **three entrypoints** in this package. They share the canonical tool catalog in [`tools_manifest.json`](./tools_manifest.json) but differ in which API key they accept and which extra tools they bundle. Pick one per IDE session:

| Entrypoint | When to use | API key type | Extra tools |
|---|---|---|---|
| [`client.js`](./client.js) | **Default for IDE agents.** Day-to-day app/tool development from your IDE on a single workspace. | Workspace-scoped (`seiva_...` from `/api-keys`) | Local checkout (`seiva_app_*`, `seiva_tool_*`) wrapping the `seiva` CLI |
| [`index.js`](./index.js) | Operating a **partnership** key across multiple workspaces from one MCP session (rare, mostly partnership admins). | Partnership-scoped | Workspace switching (`seiva_select_workspace`, `seiva_create_workspace`), members management |
| [`admin.js`](./admin.js) | Partnership catalog management (publishing partnership tools/agents/skills/apps, gating workspace permissions). | Partnership-scoped | Partnership CRUD (`seiva_publish_*`, `seiva_archive_*`, partnership-level audit) |

For 95% of users, **`client.js` is the right answer** — it's the bin exposed as `seiva-mcp-server` and what `npx -y @seiva-ai/mcp-server` runs.

## Setup (canonical IDE flow)

1. **Register the MCP server in your IDE config.** `@seiva-ai/cli` is pulled automatically as a dependency, so no global install needed — `npx` handles it. Paste your real API key from `/api-keys` and the canonical host:

   ```json
   {
     "mcpServers": {
       "seiva": {
         "command": "npx",
         "args": ["-y", "@seiva-ai/mcp-server"],
         "env": {
           "SEIVA_URL": "https://platform.seiva.ai",
           "SEIVA_API_KEY": "seiva_YOUR_API_KEY"
         }
       }
     }
   }
   ```

   Drop into `.mcp.json` at the project root (project scope) or register via `claude mcp add-json --scope user` (Claude Code user scope). VS Code (`.vscode/mcp.json`) needs top-level `servers` and `"type": "stdio"` per entry; Codex uses TOML in `~/.codex/config.toml`. The full per-IDE guide is on `/api-keys` in the platform UI.

2. **Restart the IDE.** First call to a `seiva_*` tool warms `npx`'s cache (a few seconds); subsequent calls are instant.

3. **Optional — install the CLI for direct use** (clone/push/pull/build of apps and tools from a shell, not from your IDE agent):

   ```bash
   npm install -g @seiva-ai/cli
   seiva login   # prompts for URL + API key; writes ~/.seiva/config.json (chmod 0600)
   ```

   The MCP server does **not** require `seiva login` — credentials come from the `env` block above. The CLI's config file is only consulted as a fallback when neither env var is set.

## Tool catalog

The full set of tools (with HTTP method/path and category) is documented in [`tools_manifest.json`](./tools_manifest.json). Highlights by category:

- **Apps lifecycle:** `seiva_create_app`, `seiva_list_apps`, `seiva_get_app`, `seiva_get_project_context`, `seiva_set_app_permissions`, `seiva_build_app`, `seiva_publish_app`
- **Files:** `seiva_list_files`, `seiva_read_file`, `seiva_write_file`, `seiva_edit_file_diff` (prefer this for edits), `seiva_write_files` (batch), `seiva_delete_file`
- **Runtime debugging:** `seiva_get_app_runtime_errors`, `seiva_get_build_logs`, `seiva_get_app_usage`
- **DataPacks:** `seiva_list_available_datapacks`, `seiva_describe_datapack_table`, `seiva_request_datapack_grant`
- **Cross-app:** `seiva_list_app_agents`, `seiva_request_external_dependency`, `seiva_upload_app_asset`
- **EditLock (multi-agent coordination):** `seiva_acquire_app_lock`, `seiva_renew_app_lock`, `seiva_release_app_lock`, `seiva_get_app_lock`
- **HITL approvals (polling):** `seiva_list_pending_approvals`
- **Credentials:** `seiva_list_credentials`, `seiva_create_credential`
- **Agents / Skills / Tools / Schedules:** full CRUD per category
- **Tool execution:** `seiva_execute_tool` — run any workspace tool (custom, builtin, or partnership) by name with arbitrary input, deterministically (no agent/LLM). Registered in `client.js` only — the backend requires a workspace-scoped key. Approval-gated tools fail with `requires_approval` instead of executing
- **Data grants:** `seiva_list_app_data_grants`, `seiva_grant_app_data`, `seiva_revoke_app_data`
- **Local checkout (CLI bridge):** `seiva_app_checkout_status`, `seiva_app_pull`, `seiva_app_push`, `seiva_app_build_local`, and equivalents for Python tools (`seiva_tool_*`)
- **Migration (client-only):** `seiva_analyze_external_project`, `seiva_generate_migration_plan`, `seiva_import_project_files`, `seiva_import_env_vars`
- **Logs:** `seiva_get_logs`, `seiva_get_session_logs`

### Migration flow (importing an external project)

When the user says "bring this Lovable / v0 / Next.js project into Seiva", run the migration tools in this order:

```text
1. seiva_analyze_external_project { source_path }
       → JSON: framework, deps, backend SDKs, env vars, assets, incompatibilities
2. seiva_generate_migration_plan { source_path, target_app_id? }
       → markdown plan, show to user, get confirmation
3. seiva_create_app { name, data_scope, ... }            # if target doesn't exist
4. seiva_import_env_vars { env_vars: [{ name, value }] } # before importing files
5. seiva_import_project_files { target_app_id, source_path, dry_run: true }
       → review what will land before committing
6. seiva_import_project_files { target_app_id, source_path }
       → batch upload, aborts on security-audit HIGH violation
7. seiva_request_external_dependency { host, kind, purpose }  # for each fetched host
8. seiva_build_app + iterate using classifier.agent_prompt
```

Load the framework-by-framework cheatsheet, SDK mapping (Supabase → DataPacks, Firebase → workspace users, etc.), and the "things that NEVER survive the import" list via `seiva_get_instructions` when starting a migration — the prompt lives on the platform and is delivered through that tool.

### Orientation (how the agent learns what it can/can't do)

The server ships an `instructions` field at MCP init (you'll see it in the session header) that mirrors the in-platform App Builder agent's system prompt: the session protocol plus EditLock / build-loop / HITL etiquette. The full guidance lives on the platform — load it on demand:

1. **`seiva_get_instructions("ide_agent_guide")`** first — capability map, hard limits, and a table of *which doc to load when*.
2. **`seiva_get_instructions("guardrails")`** before writing any app code — the closed library list and security rules.
3. **`seiva_list_instructions`** to discover more. Category `core` has the App Builder split (`app_builder_core` / `app_builder_discovery` / `app_builder_editing` — never the ~168KB legacy `app_builder`); category `recipes` has per-feature recipes (`recipe_forms`, `recipe_charts`, `recipe_email`, …) — load a recipe *before* coding that feature.

This is the same lazy-loading pattern the in-platform builder (Monica/Matt) uses: a small always-on core, with depth fetched on demand.

### Headless behaviour (no LiveView, no presence)

When the IDE agent operates without the platform's web editor open, three things differ from the in-browser experience:

- **Build errors:** drive the auto-fix loop yourself with the `classifier.agent_prompt` returned in 422 responses.
- **HITL approvals:** poll `seiva_list_pending_approvals` (60-120s) — there's no modal to wait on.
- **EditLock:** acquire explicitly before editing in a multi-agent session (`seiva_acquire_app_lock` + heartbeats via `seiva_renew_app_lock`).

## Related packages

- [`@seiva-ai/cli`](https://www.npmjs.com/package/@seiva-ai/cli) — `seiva` command (`clone/status/pull/push/build/publish` + tool variants). The local checkout MCP tools shell out to this CLI. Pulled automatically as a dependency.
- [`@seiva-ai/support-mcp-server`](https://www.npmjs.com/package/@seiva-ai/support-mcp-server) — separate read-only MCP for platform admins (Sentry, Fly, Cloud Run, Oban). Different auth.

## License

MIT — see [LICENSE](./LICENSE).
