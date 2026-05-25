#!/usr/bin/env node
/**
 * Seiva MCP Client — Workspace management server.
 * Uses a workspace API key. Full CRUD on workspace apps, agents, tools, skills, schedules.
 * Read-only access to partnership resources enabled for the workspace.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApi, textResult } from "./shared.js";
import { registerCheckoutTools } from "./checkout_tools.js";

// Config + state files written by `seiva login` / `seiva use` (see
// seiva-cli/lib/auth.js). Env vars take precedence so existing setups that
// only pipe SEIVA_API_KEY/SEIVA_URL via .mcp.json keep working unchanged.
function readJsonSync(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const cfg = readJsonSync(join(homedir(), ".seiva", "config.json"));
const state = readJsonSync(join(homedir(), ".seiva", "state.json"));

const SEIVA_URL = process.env.SEIVA_URL || cfg.url || "http://localhost:4000";
const SEIVA_API_KEY = process.env.SEIVA_API_KEY || cfg.api_key;
if (!SEIVA_API_KEY) {
  console.error(
    "SEIVA_API_KEY required. Set it via env var or run `seiva login`.",
  );
  process.exit(1);
}

const api = createApi(SEIVA_URL, SEIVA_API_KEY, () => null);

// Context cache for app builder guardrails
const contextCache = {};
async function getContext(appId) {
  if (!contextCache[appId]) contextCache[appId] = await api("GET", `/apps/${appId}/context`);
  return contextCache[appId];
}

const server = new McpServer({ name: "seiva-client", version: "0.1.0" });

// ── Apps (full CRUD) ────────────────────────────────────────────────────────

server.tool("seiva_list_apps", "List all apps in the workspace", {}, async () =>
  textResult(await api("GET", "/apps"))
);

server.tool("seiva_get_app", "Get app details with file count", { app_id: z.string() },
  async ({ app_id }) => textResult(await api("GET", `/apps/${app_id}`))
);

server.tool(
  "seiva_get_context",
  "Returns FULL builder context (~140KB+). WARNING: Very large. " +
    "PREFER seiva_get_project_context (structure) + seiva_get_instructions (rules) for selective loading.",
  { app_id: z.string(), user_message: z.string().optional() },
  async ({ app_id, user_message }) => {
    delete contextCache[app_id];
    const path = user_message
      ? `/apps/${app_id}/context?user_message=${encodeURIComponent(user_message)}`
      : `/apps/${app_id}/context`;
    const data = await api("GET", path);
    contextCache[app_id] = data;
    return textResult(data);
  }
);

server.tool("seiva_get_project_context",
  "Get structured project context: summary, manifest, agents/tools/workflows, palette. " +
    "For coding rules, use seiva_get_instructions.",
  { app_id: z.string(), regenerate_summary: z.boolean().optional() },
  async ({ app_id, regenerate_summary }) => {
    const q = regenerate_summary ? "?regenerate_summary=true" : "";
    return textResult(await api("GET", `/apps/${app_id}/project-context${q}`));
  }
);

server.tool("seiva_list_instructions",
  "Lists available instruction files with purpose, category, and size. Use FIRST, then load with seiva_get_instructions.",
  { category: z.string().optional() },
  async ({ category }) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    return textResult(await api("GET", `/instructions${q}`));
  }
);

server.tool("seiva_get_instructions",
  "Load instruction files by name. 'app_builder' is ~133KB — prefer 'guardrails' (~9KB). Max 5 per call.",
  { names: z.string(), compact: z.boolean().optional() },
  async ({ names, compact }) => {
    const q = compact ? "?compact=true" : "";
    return textResult(await api("GET", `/instructions/${encodeURIComponent(names)}${q}`));
  }
);

server.tool("seiva_list_files", "List files in an app", {
  app_id: z.string(), include_content: z.boolean().optional(),
}, async ({ app_id, include_content }) => {
  const q = include_content ? "?include_content=true" : "";
  return textResult(await api("GET", `/apps/${app_id}/files${q}`));
});

server.tool("seiva_read_file", "Read a file by path", {
  app_id: z.string(), path: z.string(),
}, async ({ app_id, path }) => textResult(await api("GET", `/apps/${app_id}/files/${path}`)));

server.tool(
  "seiva_write_file",
  "Create or update a file. Auto-returns builder context (guardrails, manifest) with the result.",
  { app_id: z.string(), path: z.string(), content: z.string() },
  async ({ app_id, path, content }) => {
    const ctx = await getContext(app_id);
    const result = await api("PUT", `/apps/${app_id}/files`, { path, content });
    return textResult({
      file_result: result,
      context: { guardrails_reminder: ctx.guardrails, manifest: ctx.manifest, project_summary: ctx.project_summary },
    });
  }
);

server.tool(
  "seiva_edit_file_diff",
  "Apply surgical search-and-replace diffs to an existing file. PREFER this over seiva_write_file for modifying existing files. Auto-returns context.",
  {
    app_id: z.string(),
    path: z.string(),
    edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
  },
  async ({ app_id, path, edits }) => {
    const ctx = await getContext(app_id);
    const result = await api("PATCH", `/apps/${app_id}/files`, { path, edits });
    return textResult({
      diff_result: result,
      context: { guardrails_reminder: ctx.guardrails, manifest: ctx.manifest, project_summary: ctx.project_summary },
    });
  }
);

server.tool("seiva_write_files", "Batch create/update multiple files. Auto-returns context.", {
  app_id: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
}, async ({ app_id, files }) => {
  const ctx = await getContext(app_id);
  const result = await api("PUT", `/apps/${app_id}/files/batch`, { files });
  return textResult({ files_result: result, context: { guardrails_reminder: ctx.guardrails, manifest: ctx.manifest } });
});

server.tool("seiva_delete_file", "Delete a file by path", {
  app_id: z.string(), path: z.string(),
}, async ({ app_id, path }) => {
  await api("DELETE", `/apps/${app_id}/files/${path}`);
  return textResult({ deleted: true });
});

server.tool(
  "seiva_build_app",
  "Compile and deploy app. On success returns {status, app_url, preview_url, html_size}. " +
    "On failure returns {error, classifier: {kind, summary, details, agent_prompt, retriable}} — " +
    "kind is one of code|security|infra|config|runtime. If retriable=true, refactor using " +
    "`agent_prompt` and call seiva_build_app again. If retriable=false (infra/config), surface to operator.",
  { app_id: z.string() },
  async ({ app_id }) => {
    try {
      return textResult(await api("POST", `/apps/${app_id}/build`));
    } catch (err) {
      // `shared.js#createApi` attaches the full response body on err.body
      // for non-2xx — pass the structured `classifier` payload through
      // verbatim so the agent can drive its auto-fix loop. If the older
      // builder shape (no classifier) shows up, fall back to guardrails.
      if (err.body && err.body.classifier) return textResult(err.body);
      const ctx = await getContext(app_id);
      return textResult({
        build_error: err.message,
        context_for_fix: { guardrails: ctx.guardrails, manifest: ctx.manifest },
      });
    }
  },
);

// ── New app creation + introspection (Phase 1 of the IDE MCP plan) ──────────
//
// Each tool here mirrors a capability the App Builder agent has inside the
// LiveView. Exposing them via Management API lets a headless IDE agent
// (Claude Code, Codex, Antigravity) run the same flow without depending on
// the LiveView being open.

server.tool(
  "seiva_create_app",
  "Create a new workspace app via API key. Scaffolds the React+Tailwind starter " +
    "(App.tsx, lib/seiva.ts, components/ui/*) automatically. Requires a " +
    "user-scoped API key (partnership keys cannot be the app creator).",
  {
    name: z.string(),
    description: z.string().optional(),
    kind: z.enum(["app", "widget"]).optional(),
    data_scope: z.enum(["private", "shared", "hybrid"]).optional(),
    visibility: z.string().optional(),
    initial_description: z.string().optional(),
    consulting_mode: z.boolean().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    category_id: z.string().optional(),
  },
  async (params) => textResult(await api("POST", "/apps", params))
);

server.tool(
  "seiva_publish_app",
  "Snapshot the working tree as a published version. Optional message becomes the version label.",
  { app_id: z.string(), message: z.string().optional() },
  async ({ app_id, message }) =>
    textResult(await api("POST", `/apps/${app_id}/publish`, message ? { message } : null))
);

server.tool(
  "seiva_get_app_runtime_errors",
  "List runtime errors captured by the app SDK (window.onerror, unhandledrejection, " +
    "console.error). Filter by since_minutes, error_type, search. Use after a failed " +
    "build or to debug a user-reported issue.",
  {
    app_id: z.string(),
    since_minutes: z.number().optional(),
    limit: z.number().optional(),
    search: z.string().optional(),
    error_type: z.enum(["error", "unhandledrejection", "console.error"]).optional(),
  },
  async ({ app_id, ...rest }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    }
    const q = p.toString() ? `?${p}` : "";
    return textResult(await api("GET", `/apps/${app_id}/errors${q}`));
  }
);

server.tool(
  "seiva_list_app_agents",
  "List agents available to the app (id, name, description, llm_model, allowed_tools). " +
    "Use BEFORE writing `ai.ask(\"...\", \"AgentName\")` in app code to know which names are valid.",
  { app_id: z.string() },
  async ({ app_id }) => textResult(await api("GET", `/apps/${app_id}/agents`))
);

server.tool(
  "seiva_list_available_datapacks",
  "List all Data Models (relational/Postgres) and Analytics (DuckLake/Parquet) tables " +
    "activated for the workspace, with current grants for THIS app. Read-only — pair " +
    "with seiva_request_datapack_grant to ask for access.",
  { app_id: z.string() },
  async ({ app_id }) => textResult(await api("GET", `/apps/${app_id}/datapacks`))
);

server.tool(
  "seiva_describe_datapack_table",
  "Describe a specific Data Model / Analytics table: columns, types, constraints, " +
    "sample rows. Use AFTER seiva_list_available_datapacks to confirm shape before " +
    "writing code.",
  { app_id: z.string(), pack_key: z.string(), table_name: z.string() },
  async ({ app_id, pack_key, table_name }) =>
    textResult(
      await api("GET", `/apps/${app_id}/datapacks/${pack_key}/tables/${table_name}`)
    )
);

server.tool(
  "seiva_request_datapack_grant",
  "Request workspace-admin approval to grant the app read/write access to specific tables (HITL). " +
    "Returns {status: 'pending', request_id}. Poll seiva_list_pending_approvals until the admin resolves.",
  {
    app_id: z.string(),
    requests: z.array(
      z.object({
        pack_key: z.string(),
        table_name: z.string(),
        can_read: z.boolean().optional(),
        can_write: z.boolean().optional(),
      })
    ),
    reason: z.string().optional(),
  },
  async ({ app_id, requests, reason }) =>
    textResult(
      await api("POST", `/apps/${app_id}/datapacks/grants`, { requests, reason })
    )
);

server.tool(
  "seiva_request_external_dependency",
  "Classify/approve an external host for CSP script-src or connect-src. Trusted hosts " +
    "auto-approve; unknown hosts may land as pending (admin approval). Provide a 1-sentence purpose.",
  {
    app_id: z.string(),
    host: z.string(),
    kind: z.enum(["script", "connect"]),
    purpose: z.string(),
  },
  async ({ app_id, host, kind, purpose }) =>
    textResult(await api("POST", `/apps/${app_id}/external-deps`, { host, kind, purpose }))
);

server.tool(
  "seiva_upload_app_asset",
  "Upload an asset (image, font, PDF, JSON) into the app's storage. Use during migration " +
    "for binaries/large files that should NOT live in app_files. Provide base64-encoded content.",
  {
    app_id: z.string(),
    name: z.string(),
    content_base64: z.string(),
    content_type: z.string().optional(),
    folder: z.string().optional(),
  },
  async ({ app_id, name, content_base64, content_type, folder }) =>
    textResult(
      await api("POST", `/apps/${app_id}/storage/files`, {
        name,
        content_base64,
        content_type,
        folder,
      })
    )
);

server.tool(
  "seiva_list_pending_approvals",
  "List HITL approvals still pending for the app (datapack grants, external-dep requests). " +
    "Poll this after seiva_request_datapack_grant / seiva_request_external_dependency to " +
    "detect when the admin resolves them.",
  { app_id: z.string() },
  async ({ app_id }) => textResult(await api("GET", `/apps/${app_id}/approvals`))
);

// ── Agents (CRUD) ───────────────────────────────────────────────────────────

server.tool("seiva_list_agents", "List workspace agents", {}, async () =>
  textResult(await api("GET", "/agents"))
);

server.tool("seiva_create_agent", "Create a workspace agent", {
  name: z.string(), system_prompt: z.string(), llm_model: z.string().optional(),
}, async (params) => textResult(await api("POST", "/agents", params)));

server.tool("seiva_update_agent", "Update a workspace agent", {
  id: z.string(), name: z.string().optional(), system_prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
}, async ({ id, ...params }) => textResult(await api("PUT", `/agents/${id}`, params)));

server.tool("seiva_delete_agent", "Delete (archive) a workspace agent", { id: z.string() },
  async ({ id }) => { await api("DELETE", `/agents/${id}`); return textResult({ deleted: true }); }
);

// ── Skills (CRUD) ───────────────────────────────────────────────────────────

server.tool("seiva_list_skills", "List workspace skills", {}, async () =>
  textResult(await api("GET", "/skills"))
);

server.tool("seiva_create_skill", "Create a workspace skill", {
  name: z.string(), instructions: z.string(), tools: z.array(z.string()).optional(),
}, async (params) => textResult(await api("POST", "/skills", params)));

server.tool("seiva_update_skill", "Update a workspace skill", {
  id: z.string(), name: z.string().optional(), instructions: z.string().optional(),
}, async ({ id, ...params }) => textResult(await api("PUT", `/skills/${id}`, params)));

// ── Tools (CRUD) ────────────────────────────────────────────────────────────

server.tool("seiva_list_tools", "List workspace tools", {}, async () =>
  textResult(await api("GET", "/tools"))
);

server.tool("seiva_get_tool", "Get tool details (includes code_body for debugging)", { id: z.string() },
  async ({ id }) => textResult(await api("GET", `/tools/${id}`))
);

server.tool("seiva_create_tool", "Create a workspace tool", {
  name: z.string(), description: z.string().optional(),
  handler_type: z.enum(["none", "http", "code"]).optional(),
  code_language: z.string().optional(), code_body: z.string().optional(),
  input_schema: z.string().optional(),
}, async (params) => textResult(await api("POST", "/tools", params)));

server.tool("seiva_update_tool", "Update a workspace tool", {
  id: z.string(), description: z.string().optional(),
  code_body: z.string().optional(), input_schema: z.string().optional(),
}, async ({ id, ...params }) => textResult(await api("PUT", `/tools/${id}`, params)));

server.tool("seiva_delete_tool", "Delete a workspace tool", { id: z.string() },
  async ({ id }) => { await api("DELETE", `/tools/${id}`); return textResult({ deleted: true }); }
);

// ── Schedules (CRUD) ────────────────────────────────────────────────────────

server.tool("seiva_list_schedules", "List workspace schedules", {}, async () =>
  textResult(await api("GET", "/schedules"))
);

server.tool("seiva_create_schedule", "Create a schedule", {
  name: z.string(), trigger_type: z.enum(["cron", "once", "api_only"]),
  cron_expression: z.string().optional(), prompt: z.string().optional(), agent_id: z.string().optional(),
}, async (params) => textResult(await api("POST", "/schedules", params)));

server.tool("seiva_update_schedule", "Update a schedule", {
  id: z.string(), name: z.string().optional(), cron_expression: z.string().optional(), prompt: z.string().optional(),
}, async ({ id, ...params }) => textResult(await api("PUT", `/schedules/${id}`, params)));

server.tool("seiva_fire_schedule", "Fire a schedule immediately", { id: z.string() },
  async ({ id }) => textResult(await api("POST", `/schedules/${id}/fire`))
);

server.tool("seiva_pause_schedule", "Pause a schedule", { id: z.string() },
  async ({ id }) => textResult(await api("POST", `/schedules/${id}/pause`))
);

server.tool("seiva_resume_schedule", "Resume a paused schedule", { id: z.string() },
  async ({ id }) => textResult(await api("POST", `/schedules/${id}/resume`))
);

server.tool("seiva_schedule_stats", "Get schedule statistics", {}, async () =>
  textResult(await api("GET", "/schedules/stats"))
);

// ── Logs (read-only) ────────────────────────────────────────────────────────

server.tool("seiva_get_logs", "List agent sessions with error counts", {
  source: z.string().optional(), limit: z.number().optional(),
}, async ({ source, limit }) => {
  const p = new URLSearchParams();
  if (source) p.set("source", source);
  if (limit) p.set("limit", String(limit));
  const q = p.toString() ? `?${p}` : "";
  return textResult(await api("GET", `/logs/agent/sessions${q}`));
});

server.tool("seiva_get_session_logs", "Get detailed logs for a session", {
  session_id: z.string(), level: z.string().optional(),
}, async ({ session_id, level }) => {
  const q = level ? `?level=${level}` : "";
  return textResult(await api("GET", `/logs/agent/sessions/${session_id}${q}`));
});

server.tool("seiva_get_build_logs", "Get build logs for an app (errors, warnings)", {
  app_id: z.string(), limit: z.number().optional(),
}, async ({ app_id, limit }) => {
  const q = limit ? `?limit=${limit}` : "";
  return textResult(await api("GET", `/logs/build/${app_id}${q}`));
});

server.tool("seiva_get_app_usage", "Get app usage logs", {
  app_id: z.string().optional(), status: z.string().optional(), limit: z.number().optional(),
}, async ({ app_id, status, limit }) => {
  const p = new URLSearchParams();
  if (app_id) p.set("app_id", app_id);
  if (status) p.set("status", status);
  if (limit) p.set("limit", String(limit));
  const q = p.toString() ? `?${p}` : "";
  return textResult(await api("GET", `/logs/app-usage${q}`));
});

// ── Partnership Resources (read-only, enabled for this workspace) ───────────

server.tool("seiva_list_partnership_tools",
  "List partnership tools enabled for this workspace (published, not disabled)", {},
  async () => textResult(await api("GET", "/partnership-resources/tools"))
);

server.tool("seiva_list_partnership_agents",
  "List partnership agents available to this workspace", {},
  async () => textResult(await api("GET", "/partnership-resources/agents"))
);

server.tool("seiva_list_partnership_skills",
  "List partnership skills available to this workspace", {},
  async () => textResult(await api("GET", "/partnership-resources/skills"))
);

// ── Credentials (workspace-scoped, limited surface) ─────────────────────────

server.tool(
  "seiva_list_credentials",
  "List workspace credentials. Values are NEVER returned — only id, name, type, visibility. " +
    "Use BEFORE seiva_create_credential / seiva_import_env_vars to avoid duplicates.",
  {},
  async () => textResult(await api("GET", "/credentials")),
);

server.tool(
  "seiva_create_credential",
  "Create a workspace credential. The value is encrypted at rest with AES-256-GCM " +
    "via Seiva.Credentials.encrypt_value before persistence — never logged in plaintext.",
  {
    name: z.string(),
    value: z.string(),
    type: z.string().optional(),
    visibility: z.string().optional(),
  },
  async ({ name, value, type, visibility }) =>
    textResult(await api("POST", "/credentials", { name, value, type, visibility })),
);

// ── Migration tools (Phase 2 — best-effort import of external projects) ────
//
// Workflow:
//   1. seiva_analyze_external_project — read package.json, scan files, classify
//   2. seiva_generate_migration_plan  — markdown plan based on the analysis
//   3. seiva_import_env_vars          — persist secrets as Seiva credentials
//   4. seiva_import_project_files     — batch upload source + assets
//   5. seiva_build_app                — drive the auto-fix loop
//
// All filesystem reads happen in seiva-mcp/migration.js so the helpers stay
// testable in isolation. Tools here only plumb arguments through and post
// the results to the Management API.

import {
  analyzeExternalProject,
  generateMigrationPlan,
  planImport,
  readTextFile,
  readAssetFile,
} from "./migration.js";

server.tool(
  "seiva_analyze_external_project",
  "Analyze an external project directory (Lovable export, v0, Next.js repo, etc.) " +
    "and return a structured report: framework, dependency compatibility, backend SDKs, " +
    "routes, env vars, assets, incompatibilities. Local filesystem only — does NOT upload " +
    "anything. Pair with seiva_generate_migration_plan for a human-readable summary.",
  { source_path: z.string() },
  async ({ source_path }) => textResult(analyzeExternalProject(source_path)),
);

server.tool(
  "seiva_generate_migration_plan",
  "Render a markdown migration plan from a `source_path` (re-analyzes) or a pre-computed " +
    "`analysis` object (avoids a second filesystem walk). Shows the user dep status, route style, " +
    "backend SDK mapping, env vars to import, assets to upload, and manual gaps before " +
    "anything is written to Seiva.",
  {
    source_path: z.string().optional(),
    analysis: z.any().optional(),
    target_app_id: z.string().optional(),
  },
  async ({ source_path, analysis, target_app_id }) => {
    const report = analysis || (source_path ? analyzeExternalProject(source_path) : null);
    if (!report) {
      return textResult({
        ok: false,
        error: "Provide either source_path or analysis.",
      });
    }
    return textResult(generateMigrationPlan(report, { target_app_id }));
  },
);

server.tool(
  "seiva_import_project_files",
  "Batch-import a local project tree into a Seiva app. Text files go through " +
    "PUT /apps/:id/files/batch (subject to the security auditor — rejected writes return " +
    "the same `agent_prompt` shape as build errors). Binary or oversized files are routed " +
    "to seiva_upload_app_asset automatically. Default excludes node_modules / dist / .git / " +
    "lockfiles. `include` is an array of glob-ish patterns (`src/**/*.tsx`) — when empty, " +
    "every non-excluded file is imported.",
  {
    target_app_id: z.string(),
    source_path: z.string(),
    include: z.array(z.string()).optional(),
    exclude_dirs: z.array(z.string()).optional(),
    exclude_files: z.array(z.string()).optional(),
    batch_size: z.number().optional(),
    asset_size_threshold: z.number().optional(),
    dry_run: z.boolean().optional(),
  },
  async ({
    target_app_id,
    source_path,
    include,
    exclude_dirs,
    exclude_files,
    batch_size,
    asset_size_threshold,
    dry_run,
  }) => {
    const plan = planImport(source_path, {
      include,
      exclude_dirs,
      exclude_files,
      asset_size_threshold,
    });

    if (!plan.ok) return textResult(plan);

    if (dry_run) {
      return textResult({
        ok: true,
        dry_run: true,
        summary: plan.summary,
        text_files: plan.text_files.map((f) => f.rel),
        asset_files: plan.asset_files.map((f) => ({
          path: f.rel,
          size: f.size,
          kind: f.kind,
        })),
        skipped: plan.skipped,
      });
    }

    const size = batch_size || 25;
    const results = {
      text: { ok: 0, conflict: 0, errors: [] },
      assets: { ok: 0, errors: [] },
      security_rejections: [],
      warnings: [],
    };

    // ── Text batches via /files/batch ─────────────────────────────────────
    for (let i = 0; i < plan.text_files.length; i += size) {
      const slice = plan.text_files.slice(i, i + size);
      const files = slice
        .map((f) => readTextFile(f.abs, f.rel))
        .filter(Boolean);

      try {
        const data = await api("PUT", `/apps/${target_app_id}/files/batch`, { files });
        for (const item of data || []) {
          if (item.status === "ok") results.text.ok += 1;
          else if (item.status === "conflict") results.text.conflict += 1;
          else results.text.errors.push(item);
        }
      } catch (err) {
        // The auditor (Phase 1.2) returns 422 with errors[] + agent_prompt
        // when any file in the batch tripped a HIGH rule. Surface it
        // verbatim so the agent can react — DO NOT silently retry.
        if (err.body && err.body.errors && err.body.agent_prompt) {
          results.security_rejections.push({
            batch: slice.map((f) => f.rel),
            errors: err.body.errors,
            warnings: err.body.warnings || [],
            agent_prompt: err.body.agent_prompt,
          });
          // Abort the import — the agent must refactor before continuing.
          return textResult({
            ok: false,
            stage: "security_audit",
            partial_results: results,
            ...err.body,
          });
        }
        results.text.errors.push({
          batch: slice.map((f) => f.rel),
          error: err.message,
        });
      }
    }

    // ── Assets via /storage/files ─────────────────────────────────────────
    for (const f of plan.asset_files) {
      const asset = readAssetFile(f.abs, f.rel);
      if (!asset) {
        results.assets.errors.push({ path: f.rel, error: "unreadable" });
        continue;
      }
      try {
        await api("POST", `/apps/${target_app_id}/storage/files`, {
          name: asset.name,
          content_base64: asset.content_base64,
          content_type: asset.content_type,
          folder: pathFolder(asset.path),
        });
        results.assets.ok += 1;
      } catch (err) {
        results.assets.errors.push({ path: f.rel, error: err.message });
      }
    }

    return textResult({
      ok: true,
      summary: plan.summary,
      imported: results,
    });
  },
);

server.tool(
  "seiva_import_env_vars",
  "Persist environment variables from an external project as Seiva workspace credentials " +
    "(encrypted at rest). Use during migration so secrets NEVER land in app_files. Each " +
    "entry creates a credential named after the env var; the agent then references them " +
    "in app code via `seiva.credential('NAME')` instead of `process.env.NAME`.",
  {
    env_vars: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        type: z.string().optional(),
      }),
    ),
  },
  async ({ env_vars }) => {
    const results = { created: [], skipped: [], errors: [] };

    for (const env of env_vars) {
      if (!env.value || env.value === "") {
        results.skipped.push({ name: env.name, reason: "empty value" });
        continue;
      }
      try {
        const data = await api("POST", "/credentials", {
          name: env.name,
          value: env.value,
          type: env.type || "secret",
        });
        results.created.push({ name: env.name, id: data?.id });
      } catch (err) {
        results.errors.push({ name: env.name, error: err.message });
      }
    }

    return textResult({
      ok: true,
      created_count: results.created.length,
      skipped_count: results.skipped.length,
      error_count: results.errors.length,
      ...results,
    });
  },
);

function pathFolder(p) {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : null;
}

// ── EditLock (headless coordination without a local checkout) ───────────────
//
// `client.js`+checkout already acquires/renews/releases via the CLI. These
// tools are the equivalent for an IDE agent that talks to Management API
// directly (no `.seiva/manifest.json` on disk) and still needs to coordinate
// with the LiveView editor or another headless agent on the same app.
//
// The endpoints require a user-scoped API key — partnership keys return 401.

server.tool(
  "seiva_acquire_app_lock",
  "Acquire the EditLock on an app for the current user. Returns the lock info " +
    "({holder_user_id, holder_name, acquired_at, expires_at}) on success, or 409 " +
    "with the existing holder on conflict. Default TTL 2 min; renew via seiva_renew_app_lock " +
    "every 30s to keep it alive during a long edit session.",
  {
    app_id: z.string(),
    holder_name: z.string().optional(),
    ttl_ms: z.number().optional(),
  },
  async ({ app_id, holder_name, ttl_ms }) => {
    const body = {};
    if (holder_name !== undefined) body.holder_name = holder_name;
    if (ttl_ms !== undefined) body.ttl_ms = ttl_ms;
    try {
      return textResult(await api("POST", `/apps/${app_id}/lock/acquire`, body));
    } catch (err) {
      if (err.status === 409 && err.body) return textResult(err.body);
      throw err;
    }
  },
);

server.tool(
  "seiva_renew_app_lock",
  "Renew the EditLock TTL for the current holder. Returns {status: 'renewed', lock}. " +
    "Silently re-acquires if the lock expired between heartbeats (returns status: 'acquired'). " +
    "409 if someone else now holds the lock.",
  { app_id: z.string(), ttl_ms: z.number().optional() },
  async ({ app_id, ttl_ms }) => {
    const body = {};
    if (ttl_ms !== undefined) body.ttl_ms = ttl_ms;
    try {
      return textResult(await api("POST", `/apps/${app_id}/lock/renew`, body));
    } catch (err) {
      if (err.status === 409 && err.body) return textResult(err.body);
      throw err;
    }
  },
);

server.tool(
  "seiva_release_app_lock",
  "Release the EditLock held by the current user. 204 on success, 409 if you " +
    "are not the holder. Always call this when ending a session so other agents/users " +
    "do not have to wait for TTL expiry.",
  { app_id: z.string() },
  async ({ app_id }) => {
    try {
      await api("POST", `/apps/${app_id}/lock/release`);
      return textResult({ released: true });
    } catch (err) {
      if (err.status === 409 && err.body) return textResult(err.body);
      throw err;
    }
  },
);

server.tool(
  "seiva_get_app_lock",
  "Inspect the current EditLock state for an app. Returns {status: 'free'} or " +
    "{status: 'held', lock: {holder_user_id, holder_name, acquired_at, expires_at}}. " +
    "Read-only — no side effects. Use BEFORE editing to confirm nobody else is holding the lock.",
  { app_id: z.string() },
  async ({ app_id }) => textResult(await api("GET", `/apps/${app_id}/lock`)),
);

// ── Local checkout (CLI bridge) ─────────────────────────────────────────────
// Reads `.seiva/manifest.json` in the cwd and exposes pull/push/build that
// shell out to the `seiva` CLI — see seiva-mcp/checkout_tools.js.
registerCheckoutTools(server, () => ({
  SEIVA_URL,
  SEIVA_API_KEY,
  SEIVA_WORKSPACE_ID: state.workspace_id || process.env.SEIVA_WORKSPACE_ID || "",
}));

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
