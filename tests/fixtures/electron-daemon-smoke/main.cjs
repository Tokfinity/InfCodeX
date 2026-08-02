const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { app } = require('electron');

const homeDir = requireEnvironment('KODAX_SMOKE_HOME');
const profile = requireEnvironment('KODAX_SMOKE_PROFILE');
const resultFile = requireEnvironment('KODAX_SMOKE_RESULT');
const detachFile = requireEnvironment('KODAX_SMOKE_DETACH');
const guiCountFile = requireEnvironment('KODAX_SMOKE_GUI_COUNT');
const environmentProofFile = requireEnvironment('KODAX_SMOKE_ENV_PROOF');
const consoleProbeQueryFile = requireEnvironment('KODAX_CONSOLE_PROBE_QUERY');
const ordinaryQueryCount = Number(requireEnvironment('KODAX_SMOKE_QUERY_COUNT'));

app.on('window-all-closed', () => {});

void run().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.stack : String(error) });
  app.quit();
});

async function run() {
  await app.whenReady();
  fs.appendFileSync(guiCountFile, `${process.pid}\n`, 'utf8');
  if (process.argv.includes('daemon') && process.argv.includes('serve')) {
    throw new Error('The daemon child re-entered the packaged Electron GUI application.');
  }

  prepareEnvironmentProbeExtension();
  const { connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
  const runtime = await connectKodaXRuntime({
    homeDir,
    profile,
    autoStart: true,
    clientInfo: { name: 'packaged-electron-smoke', instanceId: 'packaged-electron-smoke' },
    requirements: { daemonManagement: 1 },
  });
  await waitForFile(environmentProofFile, 15_000);
  const environmentProof = JSON.parse(fs.readFileSync(environmentProofFile, 'utf8'));
  const session = await runtime.sessions.create({
    sessionId: 'windows-gui-query-smoke',
    title: 'Windows GUI query smoke',
    projectPath: homeDir,
    surface: 'space-desktop',
  });
  for (let index = 0; index < ordinaryQueryCount; index += 1) {
    fs.writeFileSync(consoleProbeQueryFile, String(index), 'utf8');
    try {
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: `ordinary query ${index}`,
        options: { provider: 'windows-hide-smoke' },
        operation: { operationId: `windows-hide-smoke-${index}` },
      });
      await handle.result;
    } catch (error) {
      const detail = error instanceof Error ? error.stack : String(error);
      throw new Error(`Ordinary query ${index} failed: ${detail}`);
    } finally {
      fs.writeFileSync(consoleProbeQueryFile, 'idle', 'utf8');
    }
  }
  const preflight = await runtime.status.preflight();
  writeResult({
    ok: true,
    appPid: process.pid,
    runtimeId: runtime.identity.runtimeId,
    clientCount: preflight.clientCount,
    environmentProof,
    ordinaryQueryCount,
  });

  await waitForFile(detachFile, 90_000);
  await runtime.close();
  app.quit();
}

function prepareEnvironmentProbeExtension() {
  const configDir = path.join(homeDir, '.kodax');
  const extensionPath = path.join(homeDir, 'daemon-environment-probe.mjs');
  const llmEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-llm.js',
  );
  const codingEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-coding.js',
  );
  const llmUrl = pathToFileURL(llmEntry).href;
  const codingUrl = pathToFileURL(codingEntry).href;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(extensionPath, `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { KodaXBaseProvider } from ${JSON.stringify(llmUrl)};
import { toolBash } from ${JSON.stringify(codingUrl)};

class WindowsHideSmokeProvider extends KodaXBaseProvider {
  name = 'windows-hide-smoke';
  supportsThinking = false;
  config = {
    apiKeyEnv: 'KODAX_WINDOWS_HIDE_SMOKE_KEY',
    model: 'windows-hide-smoke',
    supportsThinking: false,
  };

  isConfigured() {
    return true;
  }

  async stream() {
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

const child = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
  '/d', '/s', '/c',
  'if defined ELECTRON_RUN_AS_NODE (echo present) else (echo absent)',
], { encoding: 'utf8', windowsHide: true });
const shellProbe = await toolBash(
  {
    command:
      "Write-Output 'shell-probe-ok'; "
      + "Write-Output ('node-mode=' + $(if (Test-Path Env:ELECTRON_RUN_AS_NODE) "
      + "{ $env:ELECTRON_RUN_AS_NODE } else { 'absent' }))",
  },
  {
    backups: new Map(),
    executionCwd: ${JSON.stringify(homeDir)},
    shellExecution: {
      version: 1,
      shell: {
        kind: 'powershell',
        executable: process.env.SystemRoot
          + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
        profile: 'none',
      },
      environment: { inherit: 'filtered', windowsPath: 'registry' },
      cache: { ttlMs: 0, refreshToken: 'packaged-electron-smoke' },
      probeTimeoutMs: 10_000,
    },
  },
);
const shellProbeLines = shellProbe.trim().split(/\\r?\\n/);
const shellProbeExitIndex = shellProbeLines.findIndex((line) => /^Exit: -?\\d+$/.test(line));
const shellProbeExitCode =
  shellProbeExitIndex >= 0
    ? Number.parseInt(shellProbeLines[shellProbeExitIndex].slice('Exit: '.length), 10)
    : null;
const shellProbeOutput = shellProbeLines.slice(shellProbeExitIndex + 1);
writeFileSync(${JSON.stringify(environmentProofFile)}, JSON.stringify({
  daemon: process.env.ELECTRON_RUN_AS_NODE ?? 'absent',
  externalChild: child.stdout.trim(),
  externalChildStatus: child.status,
  externalChildError: child.error?.message,
  shellProbe: shellProbeOutput[0],
  shellProbeExitCode,
  shellProbeNodeMode: shellProbeOutput[1]?.replace(/^node-mode=/, ''),
}), 'utf8');

export default function(api) {
  api.registerModelProvider({
    name: 'windows-hide-smoke',
    factory: () => new WindowsHideSmokeProvider(),
  });
  api.registerTool({
    name: 'daemon_environment_probe',
    description: 'Packaged Electron daemon environment probe',
    input_schema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
}
`, 'utf8');
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ provider: 'windows-hide-smoke', extensions: [extensionPath] }),
    'utf8',
  );
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function writeResult(value) {
  const temporary = `${resultFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  fs.renameSync(temporary, resultFile);
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for detach marker ${file}.`);
}
