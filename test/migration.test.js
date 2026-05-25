// Tests for seiva-mcp/migration.js. Uses Node's built-in `node:test` runner
// (no extra deps). Each test builds a throwaway directory under os.tmpdir()
// with mkdtempSync + writeFileSync so the scanners see a real filesystem.
//
// Run with: cd seiva-mcp && node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  analyzeExternalProject,
  generateMigrationPlan,
  planImport,
  __internal__,
} from "../migration.js";

const {
  detectFramework,
  classifyDependencies,
  detectBackendSdks,
  scanEnvFiles,
  guessContentType,
  BINARY_EXTENSIONS,
} = __internal__;

// ── Fixture helpers ───────────────────────────────────────────────────────

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), "seiva-mig-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, ...relPath.split("/"));
    const dir = fullPath.split(sep).slice(0, -1).join(sep);
    if (dir && dir !== root) mkdirSync(dir, { recursive: true });
    if (content instanceof Buffer) writeFileSync(fullPath, content);
    else writeFileSync(fullPath, content, "utf8");
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ── detectFramework ───────────────────────────────────────────────────────

test("detectFramework returns react-vite for React + Vite", () => {
  const fw = detectFramework({
    dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
    devDependencies: { vite: "^5.0.0" },
  });
  assert.equal(fw.name, "react-vite");
  assert.equal(fw.compatibility, "first-class");
});

test("detectFramework returns next with partial compatibility + notes", () => {
  const fw = detectFramework({ dependencies: { next: "^14.0.0", react: "^18" } });
  assert.equal(fw.name, "next");
  assert.equal(fw.compatibility, "partial");
  assert.match(fw.notes, /SSR/);
});

test("detectFramework flags angular as heavy-rewrite", () => {
  const fw = detectFramework({ dependencies: { "@angular/core": "^17" } });
  assert.equal(fw.name, "angular");
  assert.equal(fw.compatibility, "heavy-rewrite");
});

test("detectFramework returns vanilla when no framework deps", () => {
  const fw = detectFramework({ dependencies: { lodash: "^4" } });
  assert.equal(fw.name, "vanilla");
});

test("detectFramework handles missing package.json gracefully", () => {
  const fw = detectFramework(null);
  assert.equal(fw.name, "unknown");
});

// ── classifyDependencies ──────────────────────────────────────────────────

test("classifyDependencies buckets supported / unknown / denied", () => {
  const pkg = {
    dependencies: {
      react: "^18",
      "react-router-dom": "^6",
      lodash: "^4",
      express: "^4",
    },
  };
  const out = classifyDependencies(pkg);
  assert.equal(out.total, 4);

  const supportedNames = out.supported.map((d) => d.name).sort();
  assert.deepEqual(supportedNames, ["react", "react-router-dom"]);

  const unknownNames = out.unknown.map((d) => d.name);
  assert.deepEqual(unknownNames, ["lodash"]);

  const deniedNames = out.denied.map((d) => d.name);
  assert.deepEqual(deniedNames, ["express"]);
});

// ── detectBackendSdks ─────────────────────────────────────────────────────

test("detectBackendSdks identifies Supabase + Firebase", () => {
  const sdks = detectBackendSdks({
    dependencies: {
      "@supabase/supabase-js": "^2",
      "firebase": "^10",
      "firebase/auth": "*",
      react: "^18",
    },
  });
  const names = sdks.map((s) => s.name).sort();
  assert.deepEqual(names, ["firebase", "supabase"]);
  const supa = sdks.find((s) => s.name === "supabase");
  assert.ok(supa.packages.includes("@supabase/supabase-js"));
  assert.match(supa.recommendation, /DataPack/);
});

test("detectBackendSdks returns empty array for pure UI project", () => {
  const sdks = detectBackendSdks({ dependencies: { react: "^18", clsx: "^2" } });
  assert.deepEqual(sdks, []);
});

// ── scanEnvFiles ──────────────────────────────────────────────────────────

test("scanEnvFiles parses .env entries and preserves real value over .example", () => {
  const root = makeProject({
    ".env": "DATABASE_URL=postgres://prod\nAPI_KEY=secret123\n# comment\n",
    ".env.example": "DATABASE_URL=\nAPI_KEY=\nMISSING=",
  });

  try {
    const errors = [];
    const vars = scanEnvFiles(root, errors);
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));

    assert.equal(byName.DATABASE_URL.value, "postgres://prod");
    assert.equal(byName.API_KEY.value, "secret123");
    // MISSING only appears in .example with empty value — still listed.
    assert.equal(byName.MISSING.value, "");
    assert.equal(byName.MISSING.source, ".env.example");
    assert.deepEqual(errors, []);
  } finally {
    cleanup(root);
  }
});

// ── analyzeExternalProject (end-to-end) ───────────────────────────────────

test("analyzeExternalProject end-to-end on a Vite+Supabase fixture", () => {
  const root = makeProject({
    "package.json": JSON.stringify({
      name: "demo-app",
      dependencies: {
        react: "^18",
        "react-dom": "^18",
        "@supabase/supabase-js": "^2",
      },
      devDependencies: { vite: "^5" },
    }),
    ".env": "SUPABASE_URL=https://x.supabase.co\nSUPABASE_KEY=anon\n",
    "src/App.tsx": "import { useState } from 'react'; export default function App() { return null; }\n",
    "src/router.tsx": "import { BrowserRouter } from 'react-router-dom';\n",
    "public/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic
  });

  try {
    const report = analyzeExternalProject(root);
    assert.equal(report.ok, true);
    assert.equal(report.project_name, "demo-app");
    assert.equal(report.framework.name, "react-vite");
    assert.equal(report.framework.compatibility, "first-class");

    assert.ok(report.backend_sdks.some((s) => s.name === "supabase"));
    assert.equal(report.env_vars.length, 2);
    assert.ok(report.assets.some((a) => a.path === "public/logo.png"));
    // The fixture imports react-router-dom — scanner should detect it.
    assert.equal(report.routes.detected, true);
    assert.equal(report.routes.style, "react-router");
  } finally {
    cleanup(root);
  }
});

test("analyzeExternalProject errors for missing path", () => {
  const report = analyzeExternalProject("/this/does/not/exist/seiva-test-xyz");
  assert.equal(report.ok, false);
  assert.match(report.error, /does not exist/);
});

// ── generateMigrationPlan ─────────────────────────────────────────────────

test("generateMigrationPlan renders markdown sections from an analysis", () => {
  const root = makeProject({
    "package.json": JSON.stringify({
      name: "lovable-export",
      dependencies: { react: "^18", lodash: "^4" },
      devDependencies: { vite: "^5" },
    }),
    ".env": "API_KEY=xyz\n",
  });

  try {
    const analysis = analyzeExternalProject(root);
    const plan = generateMigrationPlan(analysis, { target_app_id: "app-123" });
    assert.equal(plan.ok, true);
    assert.match(plan.plan_markdown, /# Migration plan/);
    assert.match(plan.plan_markdown, /react-vite/);
    assert.match(plan.plan_markdown, /Environment variables/);
    assert.match(plan.plan_markdown, /API_KEY/);
    assert.match(plan.plan_markdown, /Suggested order/);
    assert.equal(plan.summary.framework, "react-vite");
    assert.equal(plan.summary.env_vars, 1);
  } finally {
    cleanup(root);
  }
});

test("generateMigrationPlan fails fast on missing analysis", () => {
  const out = generateMigrationPlan(null);
  assert.equal(out.ok, false);
});

// ── planImport ────────────────────────────────────────────────────────────

test("planImport classifies text vs asset and skips excluded dirs", () => {
  const root = makeProject({
    "src/App.tsx": "// 100 bytes of text here\n".repeat(2),
    "src/utils.ts": "export const x = 1;\n",
    "public/logo.png": Buffer.alloc(50, 0xff), // small binary
    "public/big.json": "x".repeat(150 * 1024), // 150KB text -> asset
    "node_modules/dep/index.js": "// should be skipped\n",
    "dist/build.js": "// should be skipped\n",
    "package-lock.json": "{}",
  });

  try {
    const plan = planImport(root);
    assert.equal(plan.ok, true);

    const textPaths = plan.text_files.map((f) => f.rel.replace(/\\/g, "/")).sort();
    assert.deepEqual(textPaths, ["package.json", "src/App.tsx", "src/utils.ts"].filter((p) =>
      // package.json wasn't created here; recompute properly
      textPaths.includes(p),
    ).length > 0 ? ["src/App.tsx", "src/utils.ts"] : ["src/App.tsx", "src/utils.ts"]);

    const assetPaths = plan.asset_files.map((f) => f.rel.replace(/\\/g, "/")).sort();
    assert.ok(assetPaths.includes("public/logo.png"));
    assert.ok(assetPaths.includes("public/big.json"));

    // node_modules + dist + lockfile must be filtered.
    const allPaths = [...textPaths, ...assetPaths];
    assert.ok(!allPaths.some((p) => p.includes("node_modules")));
    assert.ok(!allPaths.some((p) => p.includes("dist/")));
    assert.ok(!allPaths.includes("package-lock.json"));
  } finally {
    cleanup(root);
  }
});

test("planImport respects custom include patterns", () => {
  const root = makeProject({
    "src/App.tsx": "tsx",
    "src/legacy.css": "css",
    "src/data.json": "{}",
  });

  try {
    const plan = planImport(root, { include: ["src/*.tsx"] });
    const paths = plan.text_files.map((f) => f.rel.replace(/\\/g, "/"));
    assert.deepEqual(paths, ["src/App.tsx"]);
    // The other files must show up under `skipped` with a reason.
    const skipped = plan.skipped.map((s) => s.path);
    assert.ok(skipped.includes("src/legacy.css"));
    assert.ok(skipped.includes("src/data.json"));
  } finally {
    cleanup(root);
  }
});

// ── Utility helpers ───────────────────────────────────────────────────────

test("BINARY_EXTENSIONS covers the common cases", () => {
  for (const ext of [".png", ".jpg", ".pdf", ".woff", ".mp4", ".zip"]) {
    assert.ok(BINARY_EXTENSIONS.has(ext), `${ext} should be binary`);
  }
  for (const ext of [".tsx", ".js", ".css", ".html"]) {
    assert.ok(!BINARY_EXTENSIONS.has(ext), `${ext} should be text`);
  }
});

test("guessContentType maps common extensions", () => {
  assert.equal(guessContentType("a.png"), "image/png");
  assert.equal(guessContentType("a.woff2"), "font/woff2");
  assert.equal(guessContentType("a.pdf"), "application/pdf");
  assert.equal(guessContentType("a.unknown"), "application/octet-stream");
});
