#!/usr/bin/env node
// Layer 1 measurement (per benchmark/EVAL_GUIDELINES.md):
// Quantify preturn-injection byte distribution in native mode.
// $0 cost — no LLM calls, no code changes to the repo.
//
// What we measure (for each scenario):
//   - routingSignals_bytes       — bytes of routingSignals stringified (lightweight proposed core)
//   - moduleContext_render_bytes — bytes of renderModuleContext(...) output
//   - impactEstimate_render_bytes — bytes of renderImpactEstimate(...) output
//   - repoContext_bytes          — bytes of daemon's prebuilt repoContext (string)
//   - summary_bytes              — bytes of bundle.summary
//   - total_native_injection     — what middleware actually composes (repoContext + module + impact + ...)
//   - daemon_capsuleBytes        — daemon's self-reported capsule byte count from trace
//
// Output: c:\tmp\preturn-bytes-report.json + console table.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENDPOINT = process.env.KODAX_REPOINTEL_ENDPOINT || 'http://127.0.0.1:47891';
const KODAX_ROOT = 'c:/Works/GitWorks/KodaX-author/KodaX';
const KODAX_PRIVATE_ROOT = 'c:/Works/GitWorks/KodaX-author/KodaX-private';

// Render functions: re-implemented as faithful ports of
// query-fallback.ts:1699-1776. Pinned by `renderModuleContextSnapshot`
// docstring — same shape used by middleware/repo-intelligence.ts.
function confidenceLabel(value) {
  if (value >= 0.8) return 'high';
  if (value >= 0.65) return 'medium';
  return 'low';
}

function buildMetadataLines(carrier) {
  const lines = [];
  if (carrier?.capability) {
    const cap = carrier.capability;
    lines.push(
      `Capability: mode=${cap.mode} | engine=${cap.engine} | bridge=${cap.bridge} | level=${cap.level} | status=${cap.status}`,
    );
    const warnings = (cap.warnings || []).join(' | ');
    if (warnings) lines.push(`Warnings: ${warnings}`);
  }
  if (carrier?.trace) {
    const t = carrier.trace;
    const parts = [
      `source=${t.source}`,
      t.daemonLatencyMs !== undefined ? `daemon_ms=${t.daemonLatencyMs}` : undefined,
      t.cliLatencyMs !== undefined ? `cli_ms=${t.cliLatencyMs}` : undefined,
      t.cacheHit !== undefined ? `cache_hit=${t.cacheHit ? 'yes' : 'no'}` : undefined,
      t.capsuleBytes !== undefined ? `capsule_bytes=${t.capsuleBytes}` : undefined,
      t.capsuleEstimatedTokens !== undefined ? `capsule_tokens=${t.capsuleEstimatedTokens}` : undefined,
    ].filter(Boolean);
    if (parts.length) lines.push(`Trace: ${parts.join(' | ')}`);
  }
  return lines;
}

function renderModuleContext(result) {
  const m = result.module || {};
  return [
    `Module context for ${m.label}`,
    `Module: ${m.moduleId} [${m.kind}]`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${Number(result.confidence).toFixed(2)})`,
    `Files: ${m.fileCount} total | ${m.sourceFileCount} source | ${m.symbolCount} symbols`,
    `Languages: ${(m.languages || []).map((l) => `${l.language}/${l.capabilityTier}:${l.fileCount}`).join(' | ') || 'none'}`,
    `Dependencies: ${(m.dependencies || []).join(' | ') || 'none'}`,
    `Dependents: ${(m.dependents || []).join(' | ') || 'none'}`,
    `Entry files: ${(m.entryFiles || []).join(' | ') || 'none'}`,
    `Top symbols: ${(m.topSymbols || []).join(' | ') || 'none'}`,
    `Tests: ${(m.keyTests || []).join(' | ') || 'none'}`,
    `Docs: ${(m.keyDocs || []).join(' | ') || 'none'}`,
    `Processes: ${(m.processIds || []).join(' | ') || 'none'}`,
    `Evidence: ${(result.evidence || []).join(' | ') || 'none'}`,
    ...buildMetadataLines(result),
  ].join('\n');
}

function renderImpactEstimate(result) {
  const t = result.target || {};
  return [
    `Impact estimate for ${t.label}`,
    `Target: ${t.kind}${t.moduleId ? ` | module=${t.moduleId}` : ''}${t.filePath ? ` | file=${t.filePath}` : ''}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${Number(result.confidence).toFixed(2)})`,
    `Summary: ${result.summary}`,
    `Impacted modules: ${(result.impactedModules || []).map((m) => `${m.label}(${m.moduleId})`).join(' | ') || 'none'}`,
    `Impacted symbols: ${(result.impactedSymbols || []).map((s) => `${s.name} -> ${s.filePath}:${s.line}`).join(' | ') || 'none'}`,
    `Possible callers: ${(result.callers || []).map((c) => `${c.name} -> ${c.filePath}:${c.line}`).join(' | ') || 'none'}`,
    result.changedScope
      ? `Changed-scope overlap: ${result.changedScope.files.filter((f) =>
          (result.impactedModules || []).some((m) => m.moduleId === f.areaId)
          || (result.impactedSymbols || []).some((s) => s.filePath === f.path),
        ).length} file(s)`
      : 'Changed-scope overlap: unavailable',
    ...buildMetadataLines(result),
  ].join('\n');
}

async function callDaemon(payload) {
  const request = {
    contractVersion: 1,
    command: 'preturn',
    payload: {
      host: 'kodax',
      intent: 'auto',
      budget: 1600,
      ...payload,
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${ENDPOINT}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

const byteLen = (s) => (s == null ? 0 : Buffer.byteLength(String(s), 'utf8'));
const jsonByteLen = (obj) => (obj == null ? 0 : Buffer.byteLength(JSON.stringify(obj), 'utf8'));

async function measureScenario(label, payload) {
  console.error(`\n[${label}] calling daemon...`);
  const t0 = Date.now();
  const res = await callDaemon(payload);
  const ms = Date.now() - t0;
  const bundle = res?.result || {};
  const moduleCtx = bundle.moduleContext || null;
  const impactEst = bundle.impactEstimate || null;
  const routing = bundle.routingSignals || null;
  const repoCtx = typeof bundle.repoContext === 'string' ? bundle.repoContext : '';
  const summary = typeof bundle.summary === 'string' ? bundle.summary : '';

  // Compose what middleware/repo-intelligence.ts actually injects in
  // native mode (line 207-216): premiumContext + generatedContext +
  // moduleContext + impactContext + fallbackGuidance. We can measure
  // 4 of 5 here — generatedContext comes from OSS index, not preturn.
  const moduleRender = moduleCtx ? renderModuleContext(moduleCtx) : '';
  const impactRender = impactEst ? renderImpactEstimate(impactEst) : '';
  const moduleSection = moduleRender ? `## Active Module Intelligence\n${moduleRender}` : '';
  const impactSection = impactRender ? `## Active Impact Intelligence\n${impactRender}` : '';
  const composedInjection = [repoCtx, moduleSection, impactSection]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');

  const moduleConfidence = moduleCtx?.confidence ?? 1;
  const impactConfidence = impactEst?.confidence ?? 1;
  const lowConfidence = moduleConfidence < 0.72 || impactConfidence < 0.72;

  return {
    label,
    payload,
    daemon_status: res?.status,
    daemon_latency_ms: ms,
    daemon_self_capsuleBytes: res?.trace?.capsuleBytes ?? null,
    daemon_self_capsuleTokens: res?.trace?.capsuleEstimatedTokens ?? null,
    confidence: {
      module: moduleConfidence,
      impact: impactConfidence,
      lowConfidence,
    },
    bytes: {
      routingSignals_json: jsonByteLen(routing),
      moduleContext_render: byteLen(moduleRender),
      moduleContext_section_with_header: byteLen(moduleSection),
      impactEstimate_render: byteLen(impactRender),
      impactEstimate_section_with_header: byteLen(impactSection),
      repoContext_premium_string: byteLen(repoCtx),
      summary: byteLen(summary),
      total_native_injection: byteLen(composedInjection),
      total_native_injection_minus_routing_only_alt: byteLen(composedInjection) - jsonByteLen(routing),
    },
    raw_preview: {
      summary: summary.slice(0, 200),
      repoContext_head: repoCtx.slice(0, 300),
      moduleRender_head: moduleRender.slice(0, 300),
      impactRender_head: impactRender.slice(0, 300),
    },
    raw_bundle_keys: Object.keys(bundle),
  };
}

(async () => {
  const scenarios = [
    {
      label: 'kodax_root_fresh',
      payload: {
        executionCwd: KODAX_ROOT,
        gitRoot: KODAX_ROOT,
        targetPath: '.',
        refresh: true,
      },
    },
    {
      label: 'kodax_root_cached',
      payload: {
        executionCwd: KODAX_ROOT,
        gitRoot: KODAX_ROOT,
        targetPath: '.',
        refresh: false,
      },
    },
    {
      label: 'kodax_coding_package',
      payload: {
        executionCwd: KODAX_ROOT,
        gitRoot: KODAX_ROOT,
        targetPath: 'packages/coding',
        refresh: false,
      },
    },
    {
      label: 'kodax_coding_repo_intel_dir',
      payload: {
        executionCwd: KODAX_ROOT,
        gitRoot: KODAX_ROOT,
        targetPath: 'packages/coding/src/repo-intelligence',
        refresh: false,
      },
    },
    {
      label: 'kodax_private_repointel_core',
      payload: {
        executionCwd: KODAX_PRIVATE_ROOT,
        gitRoot: KODAX_PRIVATE_ROOT,
        targetPath: 'packages/repointel-core',
        refresh: false,
      },
    },
  ];

  const results = [];
  for (const s of scenarios) {
    try {
      results.push(await measureScenario(s.label, s.payload));
    } catch (err) {
      results.push({ label: s.label, error: String(err?.stack || err?.message || err) });
    }
  }

  const reportPath = 'c:/tmp/preturn-bytes-report.json';
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), endpoint: ENDPOINT, results }, null, 2));
  console.error(`\nWrote ${reportPath}\n`);

  // Console summary table
  const cols = [
    ['scenario', 32],
    ['conf_M/I', 12],
    ['lowConf', 7],
    ['routingJSON', 11],
    ['module_sec', 10],
    ['impact_sec', 10],
    ['repoCtx', 8],
    ['total_inj', 9],
    ['daemonCB', 9],
  ];
  const pad = (s, n) => String(s).padEnd(n);
  console.log(cols.map(([h, w]) => pad(h, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const r of results) {
    if (r.error) {
      console.log(pad(r.label, 32) + ' ERROR: ' + r.error.slice(0, 80));
      continue;
    }
    console.log([
      pad(r.label, 32),
      pad(`${Number(r.confidence.module).toFixed(2)}/${Number(r.confidence.impact).toFixed(2)}`, 12),
      pad(r.confidence.lowConfidence ? 'YES' : 'no', 7),
      pad(r.bytes.routingSignals_json, 11),
      pad(r.bytes.moduleContext_section_with_header, 10),
      pad(r.bytes.impactEstimate_section_with_header, 10),
      pad(r.bytes.repoContext_premium_string, 8),
      pad(r.bytes.total_native_injection, 9),
      pad(r.daemon_self_capsuleBytes ?? '-', 9),
    ].join(' '));
  }
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
