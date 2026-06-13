#!/usr/bin/env node
/**
 * Seiva MCP — partnership-admin alternate entrypoint.
 *
 * The canonical IDE entrypoint is `seiva-mcp/client.js`, which is referenced
 * by `.mcp.json` and powers Claude Code / Codex / Antigravity / Cursor. This
 * file (`index.js`) is kept as the partnership-admin alternate: it accepts a
 * partnership API key (`X-Seiva-API-Key`) plus optional `X-Seiva-Workspace-Id`
 * header to operate across workspaces, and exposes the partnership-level
 * helpers (workspace switching, workspace creation, member management) that
 * `client.js` does not need.
 *
 * For day-to-day IDE work, use `client.js`. Use `index.js` only when you need
 * to operate a partnership API key across multiple workspaces from one MCP
 * session. The shared set of tools (apps, files, agents, skills, tools,
 * schedules, logs) is the same in both entrypoints — see
 * `seiva-mcp/tools_manifest.json` for the canonical catalog.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEIVA_URL = process.env.SEIVA_URL || "http://localhost:4000";
const SEIVA_API_KEY = process.env.SEIVA_API_KEY;

if (!SEIVA_API_KEY) {
  console.error("SEIVA_API_KEY environment variable is required");
  process.exit(1);
}

// Selected workspace ID (for partnership keys)
let selectedWorkspaceId = process.env.SEIVA_WORKSPACE_ID || null;

// Per-session context cache (avoids repeated context fetches)
const contextCache = {};

function buildHeaders() {
  const h = {
    "X-Seiva-API-Key": SEIVA_API_KEY,
    "Content-Type": "application/json",
  };
  if (selectedWorkspaceId) {
    h["X-Seiva-Workspace-Id"] = selectedWorkspaceId;
  }
  return h;
}

async function api(method, path, body) {
  const url = `${SEIVA_URL}/api/v1/mgmt${path}`;
  const opts = { method, headers: buildHeaders() };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok) {
    const msg = json.error || (json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return json.data;
}

async function getContext(appId) {
  if (!contextCache[appId]) {
    contextCache[appId] = await api("GET", `/apps/${appId}/context`);
  }
  return contextCache[appId];
}

// ── Server Setup ────────────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS = `Seiva platform MCP (partnership key — multi-workspace).

First: call seiva_list_workspaces, then seiva_select_workspace before any
workspace-scoped action. Then follow the IDE agent protocol:
1. seiva_get_instructions("ide_agent_guide") — capabilities, limits, doc-loading map.
2. Before writing app code: seiva_get_instructions("guardrails").
3. Orient on an app via seiva_get_project_context; never start from seiva_get_context.
4. seiva_list_instructions to discover more (category "recipes" = per-feature recipes;
   never load "app_builder" legacy).
EditLock: acquire → renew 30s → release; never force a 409.
Builds: retry only when classifier.retriable=true; infra/config → surface to operator.
HITL: poll seiva_list_pending_approvals every 60-120s for pending grants/deps.`;

const server = new McpServer(
  {
    name: "seiva",
    version: "0.3.0",
  },
  { instructions: SERVER_INSTRUCTIONS }
);

// ── Workspaces ─────────────────────────────────────────────────────────────

server.tool(
  "seiva_list_workspaces",
  "List workspaces accessible by this API key. For partnership keys, returns all workspaces. " +
    "For workspace keys, returns just that workspace. " +
    "IMPORTANT: You must call seiva_select_workspace before using any other tool if using a partnership key.",
  {},
  async () => {
    const data = await api("GET", "/workspaces");
    const current = selectedWorkspaceId;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ current_workspace_id: current, workspaces: data }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "seiva_select_workspace",
  "Select which workspace to operate on. Required for partnership API keys before using any other tool. " +
    "Use seiva_list_workspaces first to see available workspaces.",
  { workspace_id: z.string().describe("Workspace ID to select") },
  async ({ workspace_id }) => {
    selectedWorkspaceId = workspace_id;
    // Clear context cache when switching workspace
    Object.keys(contextCache).forEach((k) => delete contextCache[k]);
    return {
      content: [
        { type: "text", text: `Workspace selected: ${workspace_id}. All subsequent operations will use this workspace.` },
      ],
    };
  }
);

server.tool(
  "seiva_create_workspace",
  "Create a new workspace inside the partnership of this API key. " +
    "Requires a partnership-scoped API key. Returns the created workspace (id, name, slug, status). " +
    "After creation you can call seiva_select_workspace with the returned id to start operating on it.",
  {
    name: z.string().describe("Workspace name"),
  },
  async ({ name }) => {
    const data = await api("POST", "/workspaces", { name });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Apps ────────────────────────────────────────────────────────────────────

server.tool("seiva_list_apps", "List all apps in the workspace", {}, async () => {
  const data = await api("GET", "/apps");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool(
  "seiva_get_app",
  "Get details of a specific app including file count",
  { app_id: z.string().describe("App ID") },
  async ({ app_id }) => {
    const data = await api("GET", `/apps/${app_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_get_context",
  "Returns FULL builder context (~140KB+): system prompt, guardrails, manifest, project summary, " +
    "agents, tools, workflows. WARNING: Very large response. " +
    "PREFER seiva_get_project_context (structure) + seiva_get_instructions (rules) for selective loading.",
  {
    app_id: z.string().describe("App ID"),
    user_message: z.string().optional().describe("Optional: user message for chart doc detection"),
  },
  async ({ app_id, user_message }) => {
    // Invalidate cache to get fresh context
    delete contextCache[app_id];
    const path = user_message
      ? `/apps/${app_id}/context?user_message=${encodeURIComponent(user_message)}`
      : `/apps/${app_id}/context`;
    const data = await api("GET", path);
    contextCache[app_id] = data;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_get_project_context",
  "Get structured project context: project summary, file manifest (AST with exports/imports), " +
    "available agents/tools/workflows, color palette. Use regenerate_summary to refresh the " +
    "AI-generated project analysis. For coding rules, use seiva_get_instructions instead.",
  {
    app_id: z.string().describe("App ID"),
    regenerate_summary: z
      .boolean()
      .optional()
      .describe(
        "Regenerate .project-summary.md via AI analysis (~5-10s)"
      ),
  },
  async ({ app_id, regenerate_summary }) => {
    const q = regenerate_summary ? "?regenerate_summary=true" : "";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await api("GET", `/apps/${app_id}/project-context${q}`),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "seiva_list_instructions",
  "Lists all available instruction/prompt files with purpose, category, and size. " +
    "Categories: core (builder rules, guardrails), charts (amCharts docs), " +
    "tools (tool creation), agents (agent prompts), workflows, internal. " +
    "Use this FIRST to discover what instructions exist, then load specific ones with seiva_get_instructions.",
  {
    category: z
      .string()
      .optional()
      .describe("Filter by category: core, charts, tools, agents, workflows, internal"),
  },
  async ({ category }) => {
    const q = category
      ? `?category=${encodeURIComponent(category)}`
      : "";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(await api("GET", `/instructions${q}`), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "seiva_get_instructions",
  "Load content of specific instruction files by name. Use seiva_list_instructions first. " +
    "IMPORTANT: 'app_builder' is ~133KB — prefer 'guardrails' (~9KB) for just the constraints. " +
    "For charts: always load 'amcharts5__core' + the specific chart type. Max 5 per call.",
  {
    names: z
      .string()
      .describe(
        "Comma-separated names (e.g., 'guardrails' or 'guardrails,amcharts5__core')"
      ),
    compact: z
      .boolean()
      .optional()
      .describe("Strip optional verbose sections"),
  },
  async ({ names, compact }) => {
    const q = compact ? "?compact=true" : "";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await api(
              "GET",
              `/instructions/${encodeURIComponent(names)}${q}`
            ),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "seiva_list_files",
  "List all files in an app. Use include_content=true to get file contents.",
  {
    app_id: z.string().describe("App ID"),
    include_content: z.boolean().optional().describe("Include file contents (default: false)"),
  },
  async ({ app_id, include_content }) => {
    const q = include_content ? "?include_content=true" : "";
    const data = await api("GET", `/apps/${app_id}/files${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_read_file",
  "Read a specific file by path",
  {
    app_id: z.string().describe("App ID"),
    path: z.string().describe("File path (e.g., src/App.tsx)"),
  },
  async ({ app_id, path }) => {
    const data = await api("GET", `/apps/${app_id}/files/${path}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_write_file",
  "Create or update a single file. Auto-fetches builder context (guardrails, manifest) and returns it with the result.",
  {
    app_id: z.string().describe("App ID"),
    path: z.string().describe("File path (e.g., src/App.tsx)"),
    content: z.string().describe("File content"),
  },
  async ({ app_id, path, content }) => {
    const ctx = await getContext(app_id);
    const result = await api("PUT", `/apps/${app_id}/files`, { path, content });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file_result: result,
              context: {
                guardrails_reminder: ctx.guardrails,
                manifest: ctx.manifest,
                project_summary: ctx.project_summary,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "seiva_edit_file_diff",
  "Apply surgical edits to an existing file using search-and-replace diffs. Each edit replaces the first occurrence of old_string with new_string. Supports fuzzy whitespace matching. Returns current file content on failure for easy retry. PREFER this over seiva_write_file for modifying existing files.",
  {
    app_id: z.string().describe("App ID"),
    path: z.string().describe("File path (e.g., src/App.tsx)"),
    edits: z
      .array(
        z.object({
          old_string: z
            .string()
            .describe("Exact text to find (first occurrence)"),
          new_string: z
            .string()
            .describe("Replacement text (empty string to delete)"),
        })
      )
      .describe("Array of search-and-replace operations applied sequentially"),
  },
  async ({ app_id, path, edits }) => {
    const ctx = await getContext(app_id);
    const result = await api("PATCH", `/apps/${app_id}/files`, { path, edits });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              diff_result: result,
              context: {
                guardrails_reminder: ctx.guardrails,
                manifest: ctx.manifest,
                project_summary: ctx.project_summary,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "seiva_write_files",
  "Create or update multiple files at once (batch). Auto-fetches builder context.",
  {
    app_id: z.string().describe("App ID"),
    files: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .describe("Array of {path, content} objects"),
  },
  async ({ app_id, files }) => {
    const ctx = await getContext(app_id);
    const result = await api("PUT", `/apps/${app_id}/files/batch`, { files });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              files_result: result,
              context: {
                guardrails_reminder: ctx.guardrails,
                manifest: ctx.manifest,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "seiva_delete_file",
  "Delete a file by path",
  {
    app_id: z.string().describe("App ID"),
    path: z.string().describe("File path to delete"),
  },
  async ({ app_id, path }) => {
    await api("DELETE", `/apps/${app_id}/files/${path}`);
    return { content: [{ type: "text", text: "File deleted successfully" }] };
  }
);

server.tool(
  "seiva_set_app_permissions",
  "Update an app's permissioning. Pass any subset of: " +
    "visibility ('workspace' | 'restricted'), allowed_user_ids (array), " +
    "sharing_mode ('private' | 'workspace' | 'shared'), allowed_agent_ids (array). " +
    "The app creator cannot be removed from allowed_user_ids — that returns 422.",
  {
    app_id: z.string().describe("App ID"),
    visibility: z
      .enum(["workspace", "restricted"])
      .optional()
      .describe("'workspace' = anyone in workspace; 'restricted' = only allowed_user_ids"),
    allowed_user_ids: z
      .array(z.string())
      .optional()
      .describe("User IDs allowed when visibility='restricted'. Creator is auto-included."),
    sharing_mode: z
      .enum(["private", "workspace", "shared"])
      .optional()
      .describe("Visibility scope across the workspace tree"),
    allowed_agent_ids: z
      .array(z.string())
      .optional()
      .describe("Agent IDs allowed to invoke this app"),
  },
  async ({ app_id, ...params }) => {
    const data = await api("PATCH", `/apps/${app_id}/permissions`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_build_app",
  "Compile and deploy an app. On error, returns guardrails and manifest for auto-fix.",
  { app_id: z.string().describe("App ID") },
  async ({ app_id }) => {
    try {
      const result = await api("POST", `/apps/${app_id}/build`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const ctx = await getContext(app_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                build_error: err.message,
                context_for_fix: {
                  guardrails: ctx.guardrails,
                  manifest: ctx.manifest,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// ── App Grants (DataPacks + Analytics/DuckLake) ─────────────────────────────
// Both engines (postgres relational data packs and DuckLake analytics) share
// the `app_data_pack_grants` table. The `pack_key` resolves the engine.

server.tool(
  "seiva_list_app_data_grants",
  "List per-table grants an app holds across DataPacks (relational) and " +
    "Analytics views (DuckLake). Returns rows of {pack_key, table_name, can_read, can_write}.",
  { app_id: z.string().describe("App ID") },
  async ({ app_id }) => {
    const data = await api("GET", `/apps/${app_id}/grants`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_grant_app_data",
  "Grant or update an app's read/write access to a specific table inside a " +
    "DataPack or DuckLake view. Idempotent — repeated calls update the booleans " +
    "in place. For DuckLake/analytics tables only can_read makes sense; can_write " +
    "is silently ignored at runtime (writes go via ingest keys, not the app).",
  {
    app_id: z.string().describe("App ID"),
    pack_key: z
      .string()
      .describe("Pack key (e.g. 'financial_consolidation_lite' or a DuckLake pack key)"),
    table_name: z.string().describe("Table name inside the pack"),
    can_read: z.boolean().optional().describe("Allow read access (default: false)"),
    can_write: z
      .boolean()
      .optional()
      .describe("Allow write access (only meaningful for postgres engine)"),
  },
  async ({ app_id, ...body }) => {
    const data = await api("POST", `/apps/${app_id}/grants`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_revoke_app_data",
  "Revoke an app's access to a specific table (sets both can_read and can_write " +
    "to false; row is kept for audit). Idempotent — revoking a non-existent grant " +
    "succeeds silently. Effective immediately for runtime requests, even with " +
    "previously-issued app tokens.",
  {
    app_id: z.string().describe("App ID"),
    pack_key: z.string().describe("Pack key"),
    table_name: z.string().describe("Table name"),
  },
  async ({ app_id, pack_key, table_name }) => {
    await api(
      "DELETE",
      `/apps/${app_id}/grants/${encodeURIComponent(pack_key)}/${encodeURIComponent(table_name)}`
    );
    return { content: [{ type: "text", text: "Grant revoked" }] };
  }
);

// ── Agents ──────────────────────────────────────────────────────────────────

server.tool("seiva_list_agents", "List all agents in the workspace", {}, async () => {
  const data = await api("GET", "/agents");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool(
  "seiva_get_agent",
  "Get agent details by id (name, system_prompt, llm_model, allowed_tools, allowed_skills, ...).",
  { id: z.string().describe("Agent ID") },
  async ({ id }) => {
    const data = await api("GET", `/agents/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_create_agent",
  "Create a new agent",
  {
    name: z.string().describe("Agent name"),
    system_prompt: z.string().describe("System prompt for the agent"),
    llm_model: z.string().optional().describe("LLM model (default: claude-sonnet-4-6)"),
  },
  async (params) => {
    const data = await api("POST", "/agents", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_update_agent",
  "Update an existing agent",
  {
    id: z.string().describe("Agent ID"),
    name: z.string().optional(),
    system_prompt: z.string().optional(),
    allowed_tools: z.array(z.string()).optional(),
    allowed_skills: z.array(z.string()).optional(),
  },
  async ({ id, ...params }) => {
    const data = await api("PUT", `/agents/${id}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_delete_agent",
  "Delete (archive) an agent",
  { id: z.string().describe("Agent ID") },
  async ({ id }) => {
    await api("DELETE", `/agents/${id}`);
    return { content: [{ type: "text", text: "Agent deleted" }] };
  }
);

// ── Skills ──────────────────────────────────────────────────────────────────

server.tool("seiva_list_skills", "List all skills in the workspace", {}, async () => {
  const data = await api("GET", "/skills");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool(
  "seiva_get_skill",
  "Get skill details by id (name, instructions, tools, agents, status, ...).",
  { id: z.string().describe("Skill ID") },
  async ({ id }) => {
    const data = await api("GET", `/skills/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_create_skill",
  "Create a new skill",
  {
    name: z.string().describe("Skill name"),
    instructions: z.string().describe("Instructions for using the skill"),
    tools: z.array(z.string()).optional().describe("Tool names to include"),
  },
  async (params) => {
    const data = await api("POST", "/skills", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_update_skill",
  "Update an existing skill",
  {
    id: z.string().describe("Skill ID"),
    name: z.string().optional(),
    instructions: z.string().optional(),
    tools: z.array(z.string()).optional(),
  },
  async ({ id, ...params }) => {
    const data = await api("PUT", `/skills/${id}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_delete_skill",
  "Delete (archive) a skill",
  { id: z.string().describe("Skill ID") },
  async ({ id }) => {
    await api("DELETE", `/skills/${id}`);
    return { content: [{ type: "text", text: "Skill deleted" }] };
  }
);

// ── Tools ───────────────────────────────────────────────────────────────────

server.tool("seiva_list_tools", "List all tools in the workspace", {}, async () => {
  const data = await api("GET", "/tools");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool(
  "seiva_get_tool",
  "Get tool details including code_body for debugging",
  { id: z.string().describe("Tool ID") },
  async ({ id }) => {
    const data = await api("GET", `/tools/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_create_tool",
  "Create a new custom tool",
  {
    name: z.string().describe("Tool name (snake_case)"),
    description: z.string().optional().describe("Tool description"),
    handler_type: z.enum(["none", "http", "code"]).describe("Handler type"),
    code_language: z.string().optional().describe("Code language (python)"),
    code_body: z.string().optional().describe("Python code body"),
    input_schema: z.string().optional().describe("JSON schema for input"),
  },
  async (params) => {
    const data = await api("POST", "/tools", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_update_tool",
  "Update an existing tool",
  {
    id: z.string().describe("Tool ID"),
    description: z.string().optional(),
    code_body: z.string().optional(),
    input_schema: z.string().optional(),
  },
  async ({ id, ...params }) => {
    const data = await api("PUT", `/tools/${id}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_delete_tool",
  "Delete a tool",
  { id: z.string().describe("Tool ID") },
  async ({ id }) => {
    await api("DELETE", `/tools/${id}`);
    return { content: [{ type: "text", text: "Tool deleted" }] };
  }
);

server.tool(
  "seiva_list_builtin_tools",
  "List built-in tools available to this workspace (image_create, web_search, excel readers, etc.). " +
    "Indicates which are already enabled for the current workspace.",
  {},
  async () => {
    const data = await api("GET", "/tools/builtin");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_enable_builtin_tool",
  "Enable a built-in tool for the current workspace by its builtin key " +
    "(returned by seiva_list_builtin_tools).",
  { name: z.string().describe("Built-in tool key, e.g. 'seiva_image_create'") },
  async ({ name }) => {
    const data = await api("POST", `/tools/builtin/${encodeURIComponent(name)}/enable`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Schedules ───────────────────────────────────────────────────────────────

server.tool("seiva_list_schedules", "List all schedules in the workspace", {}, async () => {
  const data = await api("GET", "/schedules");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool(
  "seiva_get_schedule",
  "Get scheduled trigger details by id (name, cron_expression, status, prompt, agent_id, fire/success/failure counts).",
  { id: z.string().describe("Schedule ID") },
  async ({ id }) => {
    const data = await api("GET", `/schedules/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_create_schedule",
  "Create a new scheduled trigger",
  {
    name: z.string().describe("Schedule name"),
    trigger_type: z.enum(["cron", "once", "api_only"]).describe("Trigger type"),
    cron_expression: z.string().optional().describe("Cron expression (for cron type)"),
    prompt: z.string().optional().describe("Prompt for the agent"),
    agent_id: z.string().optional().describe("Agent ID to use"),
  },
  async (params) => {
    const data = await api("POST", "/schedules", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_update_schedule",
  "Update an existing schedule",
  {
    id: z.string().describe("Schedule ID"),
    name: z.string().optional(),
    cron_expression: z.string().optional(),
    prompt: z.string().optional(),
  },
  async ({ id, ...params }) => {
    const data = await api("PUT", `/schedules/${id}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_delete_schedule",
  "Delete a scheduled trigger",
  { id: z.string().describe("Schedule ID") },
  async ({ id }) => {
    await api("DELETE", `/schedules/${id}`);
    return { content: [{ type: "text", text: "Schedule deleted" }] };
  }
);

server.tool(
  "seiva_fire_schedule",
  "Fire a schedule immediately (async)",
  { id: z.string().describe("Schedule ID") },
  async ({ id }) => {
    const data = await api("POST", `/schedules/${id}/fire`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_pause_schedule",
  "Pause an active schedule",
  { id: z.string().describe("Schedule ID") },
  async ({ id }) => {
    const data = await api("POST", `/schedules/${id}/pause`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_resume_schedule",
  "Resume a paused schedule",
  { id: z.string().describe("Schedule ID") },
  async ({ id }) => {
    const data = await api("POST", `/schedules/${id}/resume`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("seiva_schedule_stats", "Get schedule statistics for the workspace", {}, async () => {
  const data = await api("GET", "/schedules/stats");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// ── Members (workspace membership) ──────────────────────────────────────────

server.tool(
  "seiva_list_members",
  "List users that are members of the current workspace, with their role " +
    "(owner | admin | member | viewer).",
  {},
  async () => {
    const data = await api("GET", "/members");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_set_member_role",
  "Change a member's role in the current workspace. Roles: owner, admin, " +
    "member, viewer. Demoting the last owner is rejected with 422 — promote " +
    "another member to owner first. To grant a new user access, the user " +
    "must already be a member of the workspace (this tool does not invite).",
  {
    user_id: z.string().describe("User ID of the existing workspace member"),
    role: z.enum(["owner", "admin", "member", "viewer"]).describe("New role"),
  },
  async ({ user_id, role }) => {
    const data = await api("PATCH", `/members/${user_id}`, { role });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Logs ────────────────────────────────────────────────────────────────────

server.tool(
  "seiva_get_logs",
  "List agent sessions with error counts. Useful for finding failing sessions.",
  {
    source: z.string().optional().describe("Filter by source: chat_agent or app_builder"),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },
  async ({ source, limit }) => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (limit) params.set("limit", String(limit));
    const q = params.toString() ? `?${params}` : "";
    const data = await api("GET", `/logs/agent/sessions${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_get_session_logs",
  "Get detailed logs for a specific agent session (tool calls, errors, durations)",
  {
    session_id: z.string().describe("Session ID"),
    level: z.string().optional().describe("Filter by level: info, warn, error"),
  },
  async ({ session_id, level }) => {
    const q = level ? `?level=${level}` : "";
    const data = await api("GET", `/logs/agent/sessions/${session_id}${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_get_build_logs",
  "Get build logs for an app (errors, warnings, sizes). Use to diagnose build failures.",
  {
    app_id: z.string().describe("App ID"),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },
  async ({ app_id, limit }) => {
    const q = limit ? `?limit=${limit}` : "";
    const data = await api("GET", `/logs/build/${app_id}${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "seiva_get_app_usage",
  "Get app usage logs (data operations, agent calls, errors)",
  {
    app_id: z.string().optional().describe("Filter by app ID"),
    status: z.string().optional().describe("Filter: success or error"),
    limit: z.number().optional().describe("Max results (default: 100)"),
  },
  async ({ app_id, status, limit }) => {
    const params = new URLSearchParams();
    if (app_id) params.set("app_id", app_id);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const q = params.toString() ? `?${params}` : "";
    const data = await api("GET", `/logs/app-usage${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
