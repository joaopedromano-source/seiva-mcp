#!/usr/bin/env node
/**
 * Seiva MCP Admin — Partnership management server.
 * Uses a partnership API key. CRUD on partnership tools, agents, skills, apps.
 * Read-only access to workspace logs and schedules (via X-Seiva-Workspace-Id).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApi, textResult } from "./shared.js";

const SEIVA_URL = process.env.SEIVA_URL || "http://localhost:4000";
const SEIVA_API_KEY = process.env.SEIVA_API_KEY;
if (!SEIVA_API_KEY) { console.error("SEIVA_API_KEY required"); process.exit(1); }

let selectedWorkspaceId = null;

// Partnership API (no workspace header needed)
const pApi = createApi(SEIVA_URL, SEIVA_API_KEY, () => null);
// Workspace API (uses selected workspace header for log/schedule reads)
const wApi = createApi(SEIVA_URL, SEIVA_API_KEY, () => selectedWorkspaceId);

const SERVER_INSTRUCTIONS = `Seiva platform MCP (admin — partnership catalog management).

This entrypoint publishes/archives partnership tools, agents, skills and apps.
For app-building guidance (capabilities, guardrails, recipes), call
seiva_get_instructions("ide_agent_guide") then load specific docs on demand.
seiva_list_instructions lists the catalog (category "recipes" = per-feature recipes).`;

const server = new McpServer(
  { name: "seiva-admin", version: "0.3.0" },
  { instructions: SERVER_INSTRUCTIONS }
);

// ── Workspaces ──────────────────────────────────────────────────────────────

server.tool("seiva_list_workspaces", "List workspaces in this partnership", {}, async () => {
  const data = await pApi("GET", "/workspaces");
  return textResult({ current_workspace_id: selectedWorkspaceId, workspaces: data });
});

server.tool(
  "seiva_select_workspace",
  "Select a workspace for reading logs and schedules. Required before using log/schedule tools.",
  { workspace_id: z.string().describe("Workspace ID") },
  async ({ workspace_id }) => {
    selectedWorkspaceId = workspace_id;
    return textResult({ selected: workspace_id });
  }
);

// ── Partnership Tools ───────────────────────────────────────────────────────

server.tool("seiva_list_tools", "List all partnership tools (draft + published)", {}, async () =>
  textResult(await pApi("GET", "/partnership/tools"))
);

server.tool("seiva_get_tool", "Get partnership tool details", { id: z.string() }, async ({ id }) =>
  textResult(await pApi("GET", `/partnership/tools/${id}`))
);

server.tool("seiva_create_tool", "Create a partnership tool", {
  name: z.string().describe("Tool name (snake_case)"),
  description: z.string().optional(),
  handler_type: z.enum(["none", "http", "code"]).optional(),
  code_language: z.string().optional(),
  code_body: z.string().optional(),
  input_schema: z.string().optional(),
}, async (params) => textResult(await pApi("POST", "/partnership/tools", params)));

server.tool("seiva_update_tool", "Update a partnership tool", {
  id: z.string(), name: z.string().optional(), description: z.string().optional(),
  code_body: z.string().optional(), input_schema: z.string().optional(),
}, async ({ id, ...params }) => textResult(await pApi("PUT", `/partnership/tools/${id}`, params)));

server.tool("seiva_archive_tool", "Archive a partnership tool", { id: z.string() }, async ({ id }) => {
  await pApi("DELETE", `/partnership/tools/${id}`);
  return textResult({ archived: true });
});

server.tool("seiva_publish_tool", "Publish a partnership tool to workspaces", { id: z.string() },
  async ({ id }) => textResult(await pApi("POST", `/partnership/tools/${id}/publish`))
);

// ── Partnership Agents ──────────────────────────────────────────────────────

server.tool("seiva_list_agents", "List all partnership agents", {}, async () =>
  textResult(await pApi("GET", "/partnership/agents"))
);

server.tool("seiva_get_agent", "Get partnership agent details", { id: z.string() }, async ({ id }) =>
  textResult(await pApi("GET", `/partnership/agents/${id}`))
);

server.tool("seiva_create_agent", "Create a partnership agent", {
  name: z.string(), system_prompt: z.string(),
  llm_model: z.string().optional(), allowed_tools: z.array(z.string()).optional(),
  allowed_skills: z.array(z.string()).optional(),
}, async (params) => textResult(await pApi("POST", "/partnership/agents", params)));

server.tool("seiva_update_agent", "Update a partnership agent", {
  id: z.string(), name: z.string().optional(), system_prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(), allowed_skills: z.array(z.string()).optional(),
}, async ({ id, ...params }) => textResult(await pApi("PUT", `/partnership/agents/${id}`, params)));

server.tool("seiva_archive_agent", "Archive a partnership agent", { id: z.string() }, async ({ id }) => {
  await pApi("DELETE", `/partnership/agents/${id}`);
  return textResult({ archived: true });
});

server.tool("seiva_publish_agent", "Publish a partnership agent to workspaces", { id: z.string() },
  async ({ id }) => textResult(await pApi("POST", `/partnership/agents/${id}/publish`))
);

// ── Partnership Skills ──────────────────────────────────────────────────────

server.tool("seiva_list_skills", "List all partnership skills", {}, async () =>
  textResult(await pApi("GET", "/partnership/skills"))
);

server.tool("seiva_create_skill", "Create a partnership skill", {
  name: z.string(), instructions: z.string(), tools: z.array(z.string()).optional(),
}, async (params) => textResult(await pApi("POST", "/partnership/skills", params)));

server.tool("seiva_update_skill", "Update a partnership skill", {
  id: z.string(), name: z.string().optional(), instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
}, async ({ id, ...params }) => textResult(await pApi("PUT", `/partnership/skills/${id}`, params)));

server.tool("seiva_archive_skill", "Archive a partnership skill", { id: z.string() }, async ({ id }) => {
  await pApi("DELETE", `/partnership/skills/${id}`);
  return textResult({ archived: true });
});

server.tool("seiva_publish_skill", "Publish a partnership skill to workspaces", { id: z.string() },
  async ({ id }) => textResult(await pApi("POST", `/partnership/skills/${id}/publish`))
);

// ── Partnership Apps ────────────────────────────────────────────────────────

server.tool("seiva_list_apps", "List all partnership apps", {}, async () =>
  textResult(await pApi("GET", "/partnership/apps"))
);

server.tool("seiva_get_app", "Get partnership app details", { app_id: z.string() },
  async ({ app_id }) => textResult(await pApi("GET", `/partnership/apps/${app_id}`))
);

server.tool("seiva_create_app", "Create a partnership app", {
  name: z.string(), description: z.string().optional(),
}, async (params) => textResult(await pApi("POST", "/partnership/apps", params)));

server.tool("seiva_update_app", "Update a partnership app", {
  app_id: z.string(), name: z.string().optional(), description: z.string().optional(),
}, async ({ app_id, ...params }) => textResult(await pApi("PUT", `/partnership/apps/${app_id}`, params)));

server.tool("seiva_get_project_context",
  "Get project context for a partnership app: summary, manifest. For coding rules, use seiva_get_instructions.",
  { app_id: z.string(), regenerate_summary: z.boolean().optional() },
  async ({ app_id, regenerate_summary }) => {
    const q = regenerate_summary ? "?regenerate_summary=true" : "";
    return textResult(await pApi("GET", `/partnership/apps/${app_id}/project-context${q}`));
  }
);

server.tool("seiva_list_instructions",
  "Lists available instruction files with purpose, category, and size.",
  { category: z.string().optional() },
  async ({ category }) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    return textResult(await pApi("GET", `/instructions${q}`));
  }
);

server.tool("seiva_get_instructions",
  "Load instruction files by name. 'app_builder' is ~133KB — prefer 'guardrails'. Max 5 per call.",
  { names: z.string(), compact: z.boolean().optional() },
  async ({ names, compact }) => {
    const q = compact ? "?compact=true" : "";
    return textResult(await pApi("GET", `/instructions/${encodeURIComponent(names)}${q}`));
  }
);

server.tool("seiva_list_files", "List files of a partnership app", {
  app_id: z.string(), include_content: z.boolean().optional(),
}, async ({ app_id, include_content }) => {
  const q = include_content ? "?include_content=true" : "";
  return textResult(await pApi("GET", `/partnership/apps/${app_id}/files${q}`));
});

server.tool("seiva_read_file", "Read a file from a partnership app", {
  app_id: z.string(), path: z.string(),
}, async ({ app_id, path }) => textResult(await pApi("GET", `/partnership/apps/${app_id}/files/${path}`)));

server.tool("seiva_write_file", "Create or update a file in a partnership app", {
  app_id: z.string(), path: z.string(), content: z.string(),
}, async ({ app_id, path, content }) =>
  textResult(await pApi("PUT", `/partnership/apps/${app_id}/files`, { path, content }))
);

server.tool("seiva_edit_file_diff", "Apply surgical diffs to a file in a partnership app. PREFER over seiva_write_file for edits.", {
  app_id: z.string(), path: z.string(),
  edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
}, async ({ app_id, path, edits }) =>
  textResult(await pApi("PATCH", `/partnership/apps/${app_id}/files`, { path, edits }))
);

server.tool("seiva_write_files", "Batch create/update files in a partnership app", {
  app_id: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
}, async ({ app_id, files }) =>
  textResult(await pApi("PUT", `/partnership/apps/${app_id}/files/batch`, { files }))
);

server.tool("seiva_delete_file", "Delete a file from a partnership app", {
  app_id: z.string(), path: z.string(),
}, async ({ app_id, path }) => {
  await pApi("DELETE", `/partnership/apps/${app_id}/files/${path}`);
  return textResult({ deleted: true });
});

server.tool("seiva_build_app", "Build a partnership app", { app_id: z.string() },
  async ({ app_id }) => textResult(await pApi("POST", `/partnership/apps/${app_id}/build`))
);

server.tool("seiva_publish_app", "Publish a partnership app version", {
  app_id: z.string(), version_label: z.string().optional(), changelog: z.string().optional(),
}, async ({ app_id, ...params }) =>
  textResult(await pApi("POST", `/partnership/apps/${app_id}/publish`, params))
);

server.tool("seiva_list_versions", "List versions of a partnership app", { app_id: z.string() },
  async ({ app_id }) => textResult(await pApi("GET", `/partnership/apps/${app_id}/versions`))
);

// ── Workspace Logs (read-only, requires seiva_select_workspace) ─────────────

server.tool("seiva_get_logs", "List agent sessions (requires select_workspace first)", {
  source: z.string().optional(), limit: z.number().optional(),
}, async ({ source, limit }) => {
  const p = new URLSearchParams();
  if (source) p.set("source", source);
  if (limit) p.set("limit", String(limit));
  const q = p.toString() ? `?${p}` : "";
  return textResult(await wApi("GET", `/logs/agent/sessions${q}`));
});

server.tool("seiva_get_session_logs", "Get detailed logs for a session", {
  session_id: z.string(), level: z.string().optional(),
}, async ({ session_id, level }) => {
  const q = level ? `?level=${level}` : "";
  return textResult(await wApi("GET", `/logs/agent/sessions/${session_id}${q}`));
});

server.tool("seiva_get_build_logs", "Get build logs for a workspace app", {
  app_id: z.string(), limit: z.number().optional(),
}, async ({ app_id, limit }) => {
  const q = limit ? `?limit=${limit}` : "";
  return textResult(await wApi("GET", `/logs/build/${app_id}${q}`));
});

server.tool("seiva_get_app_usage", "Get app usage logs", {
  app_id: z.string().optional(), status: z.string().optional(), limit: z.number().optional(),
}, async ({ app_id, status, limit }) => {
  const p = new URLSearchParams();
  if (app_id) p.set("app_id", app_id);
  if (status) p.set("status", status);
  if (limit) p.set("limit", String(limit));
  const q = p.toString() ? `?${p}` : "";
  return textResult(await wApi("GET", `/logs/app-usage${q}`));
});

// ── Workspace Schedules (read-only) ─────────────────────────────────────────

server.tool("seiva_list_schedules", "List schedules in selected workspace (read-only)", {},
  async () => textResult(await wApi("GET", "/schedules"))
);

server.tool("seiva_schedule_stats", "Get schedule statistics for selected workspace", {},
  async () => textResult(await wApi("GET", "/schedules/stats"))
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
