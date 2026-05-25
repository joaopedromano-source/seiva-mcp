// MCP tools that make Claude Code aware of a Seiva checkout in the cwd.
//
// Architecture:
//   - `seiva_app_checkout_status` reads `.seiva/manifest.json` directly via
//     the CLI lib (fast, structured) so Claude can decide whether a push is
//     needed without spawning anything.
//   - `seiva_app_pull` / `seiva_app_push` / `seiva_app_build_local` spawn
//     the `seiva` CLI as a subprocess and return its output verbatim. This
//     guarantees behavioural parity between what the dev sees in their
//     terminal and what Claude Code sees, with one source of truth (the
//     CLI). The runtime cost (~100-200ms node startup) is irrelevant when
//     the operations themselves take seconds.
//
// `cwd` defaults to the MCP server's process.cwd() (set by Claude Code at
// launch time) but can be overridden per-call so the tools work even when
// Claude Code happens to be running from a sibling directory.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Resolve @seiva-ai/cli in two scenarios:
//   - PROD: user ran `npm install -g @seiva-ai/mcp-server`, which pulled
//     @seiva-ai/cli as a regular dependency. Resolves via the package name.
//   - DEV: monorepo checkout with sibling ../seiva-cli/ and no `npm install`
//     inside seiva-mcp/. Falls back to relative file URLs.
//
// Top-level await is fine — Node ESM has supported it since 14.8, and the
// MCP host imports this module before registering tools.
const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

let manifestLib;
let toolManifestLib;
let CLI_BIN;
try {
  manifestLib = await import("@seiva-ai/cli/manifest");
  toolManifestLib = await import("@seiva-ai/cli/tool_manifest");
  CLI_BIN = require_.resolve("@seiva-ai/cli/bin/seiva.js");
} catch {
  // Sibling-package fallback for the in-monorepo dev workflow.
  const siblingBin = join(__dirname, "..", "seiva-cli", "bin", "seiva.js");
  if (!existsSync(siblingBin)) {
    throw new Error(
      "Could not resolve @seiva-ai/cli — install via `npm install -g @seiva-ai/cli` or run from inside the seiva monorepo with a sibling seiva-cli/ directory.",
    );
  }
  manifestLib = await import("../seiva-cli/lib/manifest.js");
  toolManifestLib = await import("../seiva-cli/lib/tool_manifest.js");
  CLI_BIN = siblingBin;
}

const { findCheckoutRoot, readManifest, scanWorkingTree, diffWorkingTree } =
  manifestLib;
const {
  findToolCheckoutRoot,
  readToolManifest,
  readToolFiles,
  diffToolFiles,
} = toolManifestLib;

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function runCli(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("close", (code) => {
      resolve({ exit_code: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export function registerCheckoutTools(server, getEnvFn = () => ({})) {
  server.tool(
    "seiva_app_checkout_status",
    "Inspect a Seiva App checkout in the current directory. Returns app_id, " +
      "workspace_id, and a list of locally added/modified/deleted files vs " +
      "the last sync. Use this BEFORE editing files to confirm which app the " +
      "current working directory belongs to. No side effects.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Override the directory to inspect (defaults to process.cwd())."),
    },
    async ({ cwd } = {}) => {
      const start = cwd || process.cwd();
      const root = await findCheckoutRoot(start);
      if (!root) {
        return textResult({
          status: "no_checkout",
          message: `No .seiva/manifest.json found in ${start} or any parent.`,
        });
      }
      const manifest = await readManifest(root);
      const { files, errors } = await scanWorkingTree(root);
      const diff = diffWorkingTree(manifest, files);
      return textResult({
        status: "checkout",
        root,
        app_id: manifest.app_id,
        workspace_id: manifest.workspace_id,
        base_version_id: manifest.base_version_id,
        manifest_hash: manifest.manifest_hash,
        added: diff.added.map((f) => f.path),
        modified: diff.modified.map((f) => f.path),
        deleted: diff.deleted.map((f) => f.path),
        unchanged_count: diff.unchanged,
        skipped: errors,
      });
    },
  );

  server.tool(
    "seiva_app_pull",
    "Pull the latest working tree from Seiva into the current local checkout. " +
      "Refuses on dirty trees unless force=true. Wraps the `seiva pull` CLI.",
    {
      cwd: z.string().optional(),
      force: z.boolean().optional(),
    },
    async ({ cwd, force } = {}) => {
      const args = ["pull"];
      if (force) args.push("--force");
      const env = getEnvFn() || {};
      return textResult(await runCli(args, cwd, env));
    },
  );

  server.tool(
    "seiva_app_push",
    "Push the local working tree to Seiva. Acquires the EditLock and uses " +
      "optimistic concurrency (expected_sha256 per file). On conflict, " +
      "exits non-zero and tells the user to `seiva pull` first. Wraps the " +
      "`seiva push` CLI.",
    {
      cwd: z.string().optional(),
      force: z.boolean().optional(),
      message: z.string().optional(),
    },
    async ({ cwd, force, message } = {}) => {
      const args = ["push"];
      if (force) args.push("--force");
      if (message) args.push("-m", message);
      const env = getEnvFn() || {};
      return textResult(await runCli(args, cwd, env));
    },
  );

  server.tool(
    "seiva_app_build_local",
    "Build the app referenced by the current checkout, returning the preview " +
      "URL. Does NOT push first — call seiva_app_push beforehand if you have " +
      "local changes. Wraps the `seiva build` CLI.",
    { cwd: z.string().optional() },
    async ({ cwd } = {}) => {
      const env = getEnvFn() || {};
      return textResult(await runCli(["build"], cwd, env));
    },
  );

  // ── Tool checkouts (Python custom tools) ────────────────────────────────
  // Mirror of the App tools above for `kind:"tool"` checkouts. Local layout
  // is `main.py` + `input_schema.json` + `tool.json` (3 files), so the diff
  // surface is per-file rather than per-path.

  server.tool(
    "seiva_tool_checkout_status",
    "Inspect a Seiva Tool checkout in the current directory. Returns " +
      "tool_id, workspace_id, and which of (main.py, tool.json, " +
      "input_schema.json) were locally modified vs. the last sync. Use " +
      "BEFORE editing to confirm which tool the cwd belongs to. No side effects.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Override the directory to inspect (defaults to process.cwd())."),
    },
    async ({ cwd } = {}) => {
      const start = cwd || process.cwd();
      const root = await findToolCheckoutRoot(start);
      if (!root) {
        return textResult({
          status: "no_checkout",
          message:
            `No tool checkout found in ${start} or any parent. Run ` +
            `\`seiva tool clone <tool-id>\` first.`,
        });
      }
      const manifest = await readToolManifest(root);
      const { fileHashes, errors } = await readToolFiles(root);
      const diff = diffToolFiles(manifest, fileHashes);
      return textResult({
        status: "checkout",
        kind: "tool",
        root,
        tool_id: manifest.tool_id,
        workspace_id: manifest.workspace_id,
        content_sha256: manifest.content_sha256,
        modified: diff.modified,
        unchanged_count: diff.unchanged,
        scan_errors: errors,
      });
    },
  );

  server.tool(
    "seiva_tool_pull",
    "Pull the latest tool from Seiva into the current local checkout. " +
      "Refuses on dirty trees unless force=true. Wraps the `seiva tool pull` CLI.",
    {
      cwd: z.string().optional(),
      force: z.boolean().optional(),
    },
    async ({ cwd, force } = {}) => {
      const args = ["tool", "pull"];
      if (force) args.push("--force");
      const env = getEnvFn() || {};
      return textResult(await runCli(args, cwd, env));
    },
  );

  server.tool(
    "seiva_tool_push",
    "Push the local tool checkout to Seiva. Acquires the EditLock and uses " +
      "optimistic concurrency (expected_sha256). On conflict, exits non-zero " +
      "and tells the user to `seiva tool pull` first. Wraps the `seiva tool " +
      "push` CLI.",
    {
      cwd: z.string().optional(),
      force: z.boolean().optional(),
      message: z.string().optional(),
    },
    async ({ cwd, force, message } = {}) => {
      const args = ["tool", "push"];
      if (force) args.push("--force");
      if (message) args.push("-m", message);
      const env = getEnvFn() || {};
      return textResult(await runCli(args, cwd, env));
    },
  );
}
