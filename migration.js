// Migration helpers for the IDE MCP server.
//
// All filesystem inspection happens here (Node fs). The matching MCP tools
// in `client.js` are thin wrappers — they just plumb `cwd`/`source_path`
// through to these functions and forward the result back to the agent.
//
// Design goals:
//   * Pure functions where possible (parse a parsed object, not a path)
//     so the same code can be exercised by unit tests against fixture data.
//   * Best-effort: never throw for malformed input — return whatever we
//     could detect and let the agent decide what to do with gaps.
//   * No transitive npm deps beyond what `seiva-mcp/package.json` already
//     declares. fs/path/crypto from the Node stdlib only.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, sep, posix } from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

// Directories that are never useful in a Seiva app and would balloon the
// batch payload. Mirrors the CLI's `DEV_TOOLING_FILENAMES` plus the usual
// suspects from external projects.
const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  ".idea",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "__pycache__",
  ".pytest_cache",
  ".DS_Store",
]);

const DEFAULT_EXCLUDE_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  ".DS_Store",
  "Thumbs.db",
]);

// Extensions that should NEVER land in `app_files` (binary, large, or
// intrinsically not source). They get routed through `seiva_upload_app_asset`
// instead. The threshold for text files going through the asset path lives
// below as ASSET_SIZE_THRESHOLD.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".wav",
  ".ogg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

// Text files larger than this go through the asset pipeline (avoids
// blowing the batch payload on large JSON datasets, csv dumps, etc.).
const ASSET_SIZE_THRESHOLD = 100 * 1024; // 100 KB

// Frameworks the analyzer recognizes, ranked by Seiva compatibility.
// `first-class` = imports directly into the Seiva scaffold; `partial` = some
// concepts need adaptation (SSR/middlewares removed); `adaptation` = templates
// need to be rewritten as TSX; `heavy-rewrite` = essentially a rebuild.
const FRAMEWORK_FINGERPRINTS = [
  {
    name: "react-vite",
    compatibility: "first-class",
    test: (pkg) => hasDep(pkg, "react") && hasDep(pkg, "vite"),
  },
  {
    name: "react-cra",
    compatibility: "first-class",
    test: (pkg) => hasDep(pkg, "react") && hasDep(pkg, "react-scripts"),
  },
  {
    name: "next",
    compatibility: "partial",
    test: (pkg) => hasDep(pkg, "next"),
    notes: "SSR / API routes / middlewares are not available in the Seiva runtime — pages are rendered SPA-style and server logic becomes Tools or app functions.",
  },
  {
    name: "sveltekit",
    compatibility: "adaptation",
    test: (pkg) => hasDep(pkg, "@sveltejs/kit"),
    notes: ".svelte components must be rewritten as TSX. Seiva does not run a Svelte compiler.",
  },
  {
    name: "svelte",
    compatibility: "adaptation",
    test: (pkg) => hasDep(pkg, "svelte"),
    notes: ".svelte components must be rewritten as TSX.",
  },
  {
    name: "nuxt",
    compatibility: "adaptation",
    test: (pkg) => hasDep(pkg, "nuxt") || hasDep(pkg, "nuxt3"),
    notes: ".vue templates must be rewritten as TSX; SSR is not available.",
  },
  {
    name: "vue",
    compatibility: "adaptation",
    test: (pkg) => hasDep(pkg, "vue"),
    notes: ".vue templates must be rewritten as TSX.",
  },
  {
    name: "angular",
    compatibility: "heavy-rewrite",
    test: (pkg) => hasDep(pkg, "@angular/core"),
    notes: "Angular components, DI, RxJS streams are not portable — this is effectively a rebuild in React/TSX.",
  },
  {
    name: "remix",
    compatibility: "partial",
    test: (pkg) => hasDep(pkg, "@remix-run/react"),
    notes: "Loaders / actions are not available — fetch data via Seiva tools or DataPacks instead.",
  },
];

// Backend SDKs the agent should know about — each maps to a recommendation
// for the Seiva equivalent.
const BACKEND_SDK_FINGERPRINTS = [
  {
    name: "supabase",
    pkg_pattern: /^@supabase\//,
    recommendation:
      "Map Supabase tables to a Seiva DataPack (use seiva_list_available_datapacks / seiva_request_datapack_grant). Auth: replace Supabase Auth with workspace users.",
  },
  {
    name: "firebase",
    pkg_pattern: /^firebase($|\/)/,
    recommendation:
      "Firestore → app_data_records (collections) or DataPacks for structured tables. Firebase Auth → workspace users. Storage → seiva_upload_app_asset.",
  },
  {
    name: "convex",
    pkg_pattern: /^convex($|\/)/,
    recommendation:
      "Convex queries/mutations → workspace Tools (Python or HTTP) invoked via `seiva.tool.run(...)`. Schemas → DataPacks.",
  },
  {
    name: "prisma",
    pkg_pattern: /^@prisma\//,
    recommendation:
      "Prisma schemas → DataPacks (use the AI Database Designer). Server-side queries → workspace Tools.",
  },
  {
    name: "drizzle",
    pkg_pattern: /^drizzle-orm/,
    recommendation: "Drizzle schemas → DataPacks; queries → workspace Tools.",
  },
  {
    name: "axios",
    pkg_pattern: /^axios$/,
    recommendation:
      "Direct external HTTP calls require host approval — use seiva_request_external_dependency to add the API host to the app's CSP connect-src.",
  },
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Analyzes an external project on disk. Returns a structured report the agent
 * can reason about + feed into `generateMigrationPlan` / `importProjectFiles`.
 *
 * Best-effort: missing `package.json`, unreadable files, etc. are reported in
 * the `notes` array instead of throwing.
 */
export function analyzeExternalProject(sourcePath) {
  const errors = [];
  const notes = [];

  if (!sourcePath || !existsSync(sourcePath)) {
    return {
      ok: false,
      error: `Source path does not exist: ${sourcePath}`,
    };
  }

  const stat = safeStat(sourcePath);
  if (!stat || !stat.isDirectory()) {
    return {
      ok: false,
      error: `Source path is not a directory: ${sourcePath}`,
    };
  }

  const pkgPath = join(sourcePath, "package.json");
  const pkg = readJson(pkgPath, errors);
  const framework = detectFramework(pkg);
  const deps = classifyDependencies(pkg);
  const backend_sdks = detectBackendSdks(pkg);
  const env_vars = scanEnvFiles(sourcePath, errors);
  const routes = scanRoutes(sourcePath, framework, errors);
  const assets = scanAssets(sourcePath, errors);
  const incompatibilities = collectIncompatibilities(framework, deps, pkg);

  if (!pkg) {
    notes.push(
      "No package.json found at the project root — framework detection is degraded. If this is a static HTML site, that is expected.",
    );
  }

  return {
    ok: true,
    source_path: sourcePath,
    project_name: pkg?.name || basename(sourcePath),
    framework,
    deps,
    backend_sdks,
    routes,
    env_vars,
    assets,
    incompatibilities,
    notes,
    errors,
  };
}

/**
 * Renders a human-readable migration plan in markdown from an analysis report.
 * The agent shows this to the user before invoking `importProjectFiles` so
 * decisions about scope/skip are auditable.
 */
export function generateMigrationPlan(analysis, opts = {}) {
  if (!analysis || analysis.ok === false) {
    return {
      ok: false,
      error: analysis?.error || "Analysis missing or failed.",
    };
  }

  const targetAppId = opts.target_app_id || null;
  const lines = [];

  lines.push(`# Migration plan — ${analysis.project_name}`);
  lines.push("");
  if (targetAppId) {
    lines.push(`**Target Seiva app:** \`${targetAppId}\``);
    lines.push("");
  }

  lines.push("## Source framework");
  lines.push(
    `- Detected: **${analysis.framework.name}** (compatibility: \`${analysis.framework.compatibility}\`)`,
  );
  if (analysis.framework.notes) lines.push(`- ${analysis.framework.notes}`);
  lines.push("");

  lines.push("## Dependencies");
  lines.push(
    `Total: ${analysis.deps.total} (supported: ${analysis.deps.supported.length}, unknown: ${analysis.deps.unknown.length}, denied: ${analysis.deps.denied.length}).`,
  );
  if (analysis.deps.unknown.length > 0) {
    lines.push("");
    lines.push("Unknown dependencies — run `seiva_request_external_dependency` for hosts these reach, or replace with a Seiva-native equivalent:");
    for (const d of analysis.deps.unknown.slice(0, 30)) {
      lines.push(`- \`${d.name}\` (${d.version || "unspecified"})`);
    }
    if (analysis.deps.unknown.length > 30) {
      lines.push(`- ... and ${analysis.deps.unknown.length - 30} more`);
    }
  }
  if (analysis.deps.denied.length > 0) {
    lines.push("");
    lines.push("**Denied** — these MUST be replaced before importing:");
    for (const d of analysis.deps.denied) {
      lines.push(`- \`${d.name}\` — ${d.reason || "denied by Seiva policy"}`);
    }
  }
  lines.push("");

  if (analysis.backend_sdks.length > 0) {
    lines.push("## Backend SDKs to remap");
    for (const sdk of analysis.backend_sdks) {
      lines.push(`- **${sdk.name}** (${sdk.packages.join(", ")}) — ${sdk.recommendation}`);
    }
    lines.push("");
  }

  if (analysis.routes.detected) {
    lines.push("## Routes");
    lines.push(
      `Source uses ${analysis.routes.style} routing with ${analysis.routes.count} route(s). Seiva apps are SPA — convert these to state-based navigation inside \`App.tsx\` (or a top-level router component); URL-based deep linking is not supported in the runtime.`,
    );
    lines.push("");
  }

  if (analysis.env_vars.length > 0) {
    lines.push("## Environment variables");
    lines.push(
      "Run `seiva_import_env_vars` to persist these as workspace credentials (encrypted). NEVER hardcode them in app code.",
    );
    for (const env of analysis.env_vars.slice(0, 30)) {
      lines.push(`- \`${env.name}\` (from \`${env.source}\`${env.value ? "" : " — value blank"})`);
    }
    lines.push("");
  }

  if (analysis.assets.length > 0) {
    lines.push("## Assets");
    lines.push(
      `${analysis.assets.length} binary/large file(s) detected (images, fonts, PDFs, oversized JSON). \`seiva_import_project_files\` routes these through \`seiva_upload_app_asset\` automatically — they do NOT land in app_files.`,
    );
    lines.push("");
  }

  if (analysis.incompatibilities.length > 0) {
    lines.push("## Manual gaps");
    for (const gap of analysis.incompatibilities) {
      lines.push(`- ${gap}`);
    }
    lines.push("");
  }

  if (analysis.notes.length > 0 || analysis.errors.length > 0) {
    lines.push("## Notes");
    for (const note of analysis.notes) lines.push(`- ${note}`);
    for (const err of analysis.errors) lines.push(`- ⚠️ ${err}`);
    lines.push("");
  }

  lines.push("## Suggested order");
  lines.push("1. Review denied/unknown deps and refactor where needed.");
  lines.push("2. `seiva_import_env_vars` for the secrets section.");
  lines.push("3. `seiva_import_project_files` (exclude generated/build dirs).");
  lines.push("4. `seiva_request_external_dependency` for each host the app fetches from.");
  lines.push("5. `seiva_build_app` and iterate on the classifier output.");

  return {
    ok: true,
    target_app_id: targetAppId,
    plan_markdown: lines.join("\n"),
    summary: {
      framework: analysis.framework.name,
      compatibility: analysis.framework.compatibility,
      deps_total: analysis.deps.total,
      backend_sdks: analysis.backend_sdks.map((s) => s.name),
      env_vars: analysis.env_vars.length,
      assets: analysis.assets.length,
    },
  };
}

/**
 * Walks the source tree and returns the file list classified into "text"
 * (candidate for `app_files` batch) and "asset" (candidate for storage
 * upload). Caller decides what to actually POST — keeping the side effects
 * in the MCP tool layer makes the helpers trivially testable.
 */
export function planImport(sourcePath, opts = {}) {
  if (!existsSync(sourcePath) || !safeStat(sourcePath)?.isDirectory()) {
    return { ok: false, error: `Not a directory: ${sourcePath}` };
  }

  const includePatterns = (opts.include || []).map(toRegex);
  const extraExcludeDirs = new Set(opts.exclude_dirs || []);
  const extraExcludeFiles = new Set(opts.exclude_files || []);

  const text = [];
  const assets = [];
  const skipped = [];

  walk(sourcePath, sourcePath, {
    extraExcludeDirs,
    extraExcludeFiles,
    includePatterns,
    text,
    assets,
    skipped,
    sizeThreshold: opts.asset_size_threshold || ASSET_SIZE_THRESHOLD,
  });

  return {
    ok: true,
    source_path: sourcePath,
    text_files: text,
    asset_files: assets,
    skipped,
    summary: {
      text_count: text.length,
      asset_count: assets.length,
      skipped_count: skipped.length,
      text_total_bytes: text.reduce((acc, f) => acc + f.size, 0),
      asset_total_bytes: assets.reduce((acc, f) => acc + f.size, 0),
    },
  };
}

/**
 * Reads a text file from disk safely (returns {path, content, size} or
 * null when the file is unreadable / too large for app_files).
 */
export function readTextFile(absPath, relPath) {
  try {
    const buf = readFileSync(absPath);
    return {
      path: toPosix(relPath),
      content: buf.toString("utf8"),
      size: buf.length,
    };
  } catch {
    return null;
  }
}

/**
 * Reads a binary file from disk and returns base64 content suitable for
 * the `seiva_upload_app_asset` payload.
 */
export function readAssetFile(absPath, relPath) {
  try {
    const buf = readFileSync(absPath);
    return {
      name: basename(relPath),
      path: toPosix(relPath),
      content_base64: buf.toString("base64"),
      content_type: guessContentType(relPath),
      size: buf.length,
    };
  } catch {
    return null;
  }
}

// ── Framework / dependency / SDK detection ────────────────────────────────

function detectFramework(pkg) {
  if (!pkg) return { name: "unknown", compatibility: "unknown" };

  for (const fp of FRAMEWORK_FINGERPRINTS) {
    if (fp.test(pkg)) {
      const out = { name: fp.name, compatibility: fp.compatibility };
      if (fp.notes) out.notes = fp.notes;
      return out;
    }
  }

  // No framework deps detected — probably a static HTML site or pre-React app.
  return { name: "vanilla", compatibility: "first-class" };
}

function classifyDependencies(pkg) {
  if (!pkg) return { total: 0, supported: [], unknown: [], denied: [] };

  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  const names = Object.keys(allDeps);

  // Heuristic supported list — mirrors the deps the `code_builder` bundle
  // currently knows how to resolve. Anything else is "unknown" so the
  // agent surfaces it to the user before building. The matching call to
  // `seiva_request_external_dependency` covers hosts (CSP), not npm packages.
  const supported_set = new Set([
    "react",
    "react-dom",
    "react-router-dom",
    "@heroicons/react",
    "echarts",
    "echarts-for-react",
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@tiptap/react",
    "@tiptap/starter-kit",
    "tailwindcss",
    "clsx",
    "date-fns",
    "framer-motion",
    "lucide-react",
    "react-hook-form",
    "zod",
    "zustand",
  ]);

  // Hard-deny known-incompatible runtimes.
  const denied_pattern = /^(electron|@nrwl\/|@angular\/|nestjs|express|fastify|koa)/;

  const supported = [];
  const unknown = [];
  const denied = [];

  for (const name of names) {
    const entry = { name, version: allDeps[name] };
    if (supported_set.has(name)) {
      supported.push(entry);
    } else if (denied_pattern.test(name)) {
      denied.push({ ...entry, reason: "Not supported in the Seiva client runtime" });
    } else {
      unknown.push(entry);
    }
  }

  return {
    total: names.length,
    supported,
    unknown,
    denied,
  };
}

function detectBackendSdks(pkg) {
  if (!pkg) return [];

  const allDeps = Object.keys({
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  });

  const found = new Map();

  for (const dep of allDeps) {
    for (const fp of BACKEND_SDK_FINGERPRINTS) {
      if (fp.pkg_pattern.test(dep)) {
        const existing = found.get(fp.name) || {
          name: fp.name,
          packages: [],
          recommendation: fp.recommendation,
        };
        existing.packages.push(dep);
        found.set(fp.name, existing);
      }
    }
  }

  return Array.from(found.values());
}

function scanEnvFiles(sourcePath, errors) {
  const candidates = [".env", ".env.example", ".env.local", ".env.production"];
  const seen = new Map();

  for (const filename of candidates) {
    const fullPath = join(sourcePath, filename);
    if (!existsSync(fullPath)) continue;

    try {
      const raw = readFileSync(fullPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;
        const name = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        // Last-wins, prefer real over .example so `value` flips from blank to real.
        const existing = seen.get(name);
        if (!existing || (!existing.value && value)) {
          seen.set(name, { name, value, source: filename });
        }
      }
    } catch (e) {
      errors.push(`Failed to read ${filename}: ${e.message}`);
    }
  }

  return Array.from(seen.values());
}

function scanRoutes(sourcePath, framework, errors) {
  // Cheap heuristic: only look for the canonical router imports / file
  // patterns. Real route extraction would need AST parsing — out of scope
  // for v1 (agent reads file list and figures out structure).
  const findings = { detected: false, style: "unknown", count: 0 };

  const reactRouterImports = grepCount(sourcePath, /from ["']react-router(-dom)?["']/, errors);
  if (reactRouterImports > 0) {
    findings.detected = true;
    findings.style = "react-router";
    findings.count = reactRouterImports;
    return findings;
  }

  if (framework.name === "next") {
    const appDir = join(sourcePath, "app");
    const pagesDir = join(sourcePath, "pages");
    let count = 0;
    if (existsSync(appDir)) count += countFiles(appDir, /^(page|layout|route)\.(tsx?|jsx?)$/);
    if (existsSync(pagesDir)) count += countFiles(pagesDir, /\.(tsx?|jsx?)$/);
    if (count > 0) {
      findings.detected = true;
      findings.style = "next-file-based";
      findings.count = count;
    }
    return findings;
  }

  const vueRouterImports = grepCount(sourcePath, /from ["']vue-router["']/, errors);
  if (vueRouterImports > 0) {
    findings.detected = true;
    findings.style = "vue-router";
    findings.count = vueRouterImports;
  }

  return findings;
}

function scanAssets(sourcePath, errors) {
  const assets = [];

  walkLite(sourcePath, sourcePath, (rel, abs, st) => {
    if (st.isDirectory()) return;
    const ext = extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      assets.push({ path: toPosix(rel), size: st.size, kind: classifyAssetKind(ext) });
    } else if (st.size > ASSET_SIZE_THRESHOLD) {
      assets.push({
        path: toPosix(rel),
        size: st.size,
        kind: "oversized-text",
      });
    }
  }, errors);

  return assets;
}

function classifyAssetKind(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff"].includes(ext)) {
    return "image";
  }
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "font";
  if (ext === ".pdf") return "pdf";
  if ([".mp3", ".wav", ".ogg"].includes(ext)) return "audio";
  if ([".mp4", ".webm"].includes(ext)) return "video";
  return "binary";
}

function collectIncompatibilities(framework, deps, pkg) {
  const issues = [];

  if (framework.compatibility === "heavy-rewrite") {
    issues.push(
      `${framework.name} apps require a full rewrite in React+TSX before importing — files will land in app_files but the components won't run as-is.`,
    );
  }

  if (framework.name === "next") {
    issues.push(
      "Next.js `getServerSideProps` / API routes / middleware / Route Handlers do not exist in Seiva — move that logic into workspace Tools.",
    );
  }

  if (deps.unknown.some((d) => d.name === "tailwindcss" && (d.version || "").startsWith("^3"))) {
    issues.push(
      "Source uses Tailwind v3 — Seiva apps run on Tailwind via the scaffold's `styles.css` (no separate tailwind.config.js). Existing `tailwind.config.js` will be ignored.",
    );
  }

  if (pkg && pkg.scripts && Object.keys(pkg.scripts).some((s) => /lint|test|typecheck/.test(s))) {
    // Informational — Seiva apps don't run lint/test pipelines.
    // Skip in incompatibilities (it's not a blocker).
  }

  return issues;
}

// ── Filesystem walkers ─────────────────────────────────────────────────────

function walk(rootAbs, currentAbs, ctx) {
  let entries;
  try {
    entries = readdirSync(currentAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentAbs, entry.name);
    const rel = relative(rootAbs, fullPath);

    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name) || ctx.extraExcludeDirs.has(entry.name)) {
        continue;
      }
      walk(rootAbs, fullPath, ctx);
      continue;
    }

    if (!entry.isFile()) continue;
    if (DEFAULT_EXCLUDE_FILES.has(entry.name) || ctx.extraExcludeFiles.has(entry.name)) {
      continue;
    }

    if (ctx.includePatterns.length > 0) {
      const match = ctx.includePatterns.some((re) => re.test(toPosix(rel)));
      if (!match) {
        ctx.skipped.push({ path: toPosix(rel), reason: "no-include-match" });
        continue;
      }
    }

    const st = safeStat(fullPath);
    if (!st) {
      ctx.skipped.push({ path: toPosix(rel), reason: "stat-failed" });
      continue;
    }

    const ext = extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      ctx.assets.push({ rel, abs: fullPath, size: st.size, kind: classifyAssetKind(ext) });
    } else if (st.size > ctx.sizeThreshold) {
      ctx.assets.push({ rel, abs: fullPath, size: st.size, kind: "oversized-text" });
    } else {
      ctx.text.push({ rel, abs: fullPath, size: st.size });
    }
  }
}

function walkLite(rootAbs, currentAbs, fn, errors) {
  let entries;
  try {
    entries = readdirSync(currentAbs, { withFileTypes: true });
  } catch (e) {
    errors.push(`Failed to read ${currentAbs}: ${e.message}`);
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
    const fullPath = join(currentAbs, entry.name);
    const st = safeStat(fullPath);
    if (!st) continue;
    if (entry.isDirectory()) {
      walkLite(rootAbs, fullPath, fn, errors);
    } else if (entry.isFile()) {
      const rel = relative(rootAbs, fullPath);
      fn(rel, fullPath, st);
    }
  }
}

function countFiles(rootAbs, regex) {
  let count = 0;
  try {
    const entries = readdirSync(rootAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
        count += countFiles(join(rootAbs, entry.name), regex);
      } else if (entry.isFile() && regex.test(entry.name)) {
        count += 1;
      }
    }
  } catch {
    // ignore
  }
  return count;
}

// Cheap "grep -l" that counts how many `.tsx/.ts/.jsx/.js` files in `src/`
// match a regex. Avoids reading the whole tree — only the most likely
// folder. Returns 0 if `src/` doesn't exist.
function grepCount(sourcePath, regex, errors) {
  const root = join(sourcePath, "src");
  if (!existsSync(root)) return 0;

  let hits = 0;
  const errs = [];

  walkLite(root, root, (rel, abs, st) => {
    if (!/\.(tsx?|jsx?)$/.test(rel)) return;
    if (st.size > 200 * 1024) return; // skip oversized files
    try {
      const content = readFileSync(abs, "utf8");
      if (regex.test(content)) hits += 1;
    } catch (e) {
      errs.push(e.message);
    }
  }, errs);

  if (errs.length > 0) errors.push(`grepCount: ${errs.length} unreadable files`);
  return hits;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function hasDep(pkg, name) {
  if (!pkg) return false;
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readJson(path, errors) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`Failed to parse ${path}: ${e.message}`);
    return null;
  }
}

function basename(p) {
  return p.split(/[\\/]/).pop() || p;
}

function toPosix(p) {
  return p.split(sep).join(posix.sep);
}

function toRegex(pattern) {
  if (pattern instanceof RegExp) return pattern;
  // Treat as glob-ish: escape regex specials except `*` and `?` which become
  // `.*` and `.`. Good enough for the include patterns the agent passes.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function guessContentType(path) {
  const ext = extname(path).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".json": "application/json",
    ".csv": "text/csv",
  };
  return map[ext] || "application/octet-stream";
}

// Exposed for tests.
export const __internal__ = {
  FRAMEWORK_FINGERPRINTS,
  BACKEND_SDK_FINGERPRINTS,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILES,
  BINARY_EXTENSIONS,
  ASSET_SIZE_THRESHOLD,
  detectFramework,
  classifyDependencies,
  detectBackendSdks,
  scanEnvFiles,
  scanRoutes,
  scanAssets,
  guessContentType,
};
