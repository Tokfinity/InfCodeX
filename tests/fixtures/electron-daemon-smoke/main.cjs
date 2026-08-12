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
const sessionId = requireEnvironment('KODAX_SMOKE_SESSION_ID');
const workspaceDir = path.join(homeDir, 'workspace');
const standaloneProbeDir = path.join(homeDir, 'standalone-probe');

app.on('window-all-closed', () => {});

void run().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.stack : String(error) });
  app.quit();
});

async function run() {
  await app.whenReady();
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(standaloneProbeDir, { recursive: true });
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
  if (environmentProof.sandboxDoctor?.ready !== true) {
    throw new Error(
      'Packaged daemon OS sandbox is unavailable: '
      + JSON.stringify(environmentProof.sandboxDoctor),
    );
  }
  if (
    environmentProof.directSandboxProbe?.status !== 'completed'
    || environmentProof.directSandboxProbe.exitCode !== 0
    || environmentProof.directSandboxProbe.stdout !== 'direct-sandbox-ok'
  ) {
    throw new Error(
      'Packaged Electron sandbox target bootstrap failed: '
      + JSON.stringify(environmentProof.directSandboxProbe),
    );
  }
  if (
    environmentProof.directPowerShellProbe?.status !== 'completed'
    || environmentProof.directPowerShellProbe.exitCode !== 0
    || !environmentProof.directPowerShellProbe.stdout.includes('direct-powershell-ok')
  ) {
    throw new Error(
      'Direct restricted-user PowerShell probe failed: '
      + JSON.stringify(environmentProof.directPowerShellProbe),
    );
  }
  const session = await runtime.sessions.create({
    sessionId,
    title: 'Windows GUI query smoke',
    projectPath: workspaceDir,
    surface: 'space-desktop',
  });
  await runtime.sessions.updateSettings(session.id, {
    permissionMode: 'auto',
    autoModeEngine: 'rules',
    shellExecution: {
      version: 1,
      shell: {
        kind: 'powershell',
        executable: process.env.SystemRoot
          + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        profile: 'none',
      },
      environment: { inherit: 'filtered', windowsPath: 'registry' },
      cache: { ttlMs: 0, refreshToken: 'packaged-electron-runtime-sandbox' },
      probeTimeoutMs: 10_000,
    },
  });
  const permissionSubscription = runtime.events.subscribe({
    sessionId: session.id,
    type: 'permission.requested',
  }, (event) => {
    const request = event.payload;
    if (request?.toolName !== 'bash' || typeof request.id !== 'string') return;
    void runtime.permissions.respond(request.id, { type: 'allow_once' }, {
      runId: request.runId,
    });
  });
  const sandboxedRuns = new Set();
  const sandboxSubscription = runtime.events.subscribe({
    sessionId: session.id,
    type: 'tool.sandbox',
  }, (event) => {
    if (
      typeof event.runId === 'string'
      && event.payload?.update?.observation?.state === 'applied'
      && event.payload.update.observation.backend === 'windows-restricted-user'
    ) {
      sandboxedRuns.add(event.runId);
    }
  });
  let appliedSandboxCount = 0;
  try {
    for (let index = 0; index < ordinaryQueryCount; index += 1) {
      fs.writeFileSync(consoleProbeQueryFile, String(index), 'utf8');
      try {
        const handle = await runtime.runs.start({
          sessionId: session.id,
          prompt: `ordinary query ${index}`,
          options: { provider: 'windows-hide-smoke' },
          operation: { operationId: `windows-hide-smoke-${sessionId}-${index}` },
        });
        const completed = await handle.result;
        if (completed.phase !== 'completed') {
          throw completed.error ?? new Error(`Runtime shell query ended in phase ${completed.phase}.`);
        }
        if (!sandboxedRuns.has(handle.runId)) {
          throw new Error(`Ordinary query ${index} did not report an applied Windows sandbox.`);
        }
        appliedSandboxCount += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.stack : String(error);
        throw new Error(`Ordinary query ${index} failed: ${detail}`);
      } finally {
        fs.writeFileSync(consoleProbeQueryFile, 'idle', 'utf8');
      }
    }
  } finally {
    sandboxSubscription.close();
    permissionSubscription.close();
  }
  const preflight = await runtime.status.preflight();
  writeResult({
    ok: true,
    appPid: process.pid,
    runtimeId: runtime.identity.runtimeId,
    clientCount: preflight.clientCount,
    environmentProof,
    ordinaryQueryCount,
    appliedSandboxCount,
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
  const sandboxEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-sandbox.js',
  );
  const llmUrl = pathToFileURL(llmEntry).href;
  const codingUrl = pathToFileURL(codingEntry).href;
  const sandboxUrl = pathToFileURL(sandboxEntry).href;
  const powerShellCommand = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const powerShellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "if ($env:ELECTRON_RUN_AS_NODE) { Write-Error 'Electron Node mode leaked'; exit 97 }; Write-Output 'direct-powershell-ok'",
  ];
  const powerShellProbeScript = [
    "const { spawnSync } = require('node:child_process');",
    `const result = spawnSync(${JSON.stringify(powerShellCommand)}, ${JSON.stringify(powerShellArgs)}, { encoding: 'utf8' });`,
    "process.stdout.write(result.stdout ?? '');",
    "process.stderr.write(result.stderr ?? '');",
    "process.exit(result.status ?? 1);",
  ].join(' ');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(extensionPath, `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { KodaXBaseProvider } from ${JSON.stringify(llmUrl)};
import { toolBash } from ${JSON.stringify(codingUrl)};
import { doctorKodaXSandbox, runKodaXSandboxed } from ${JSON.stringify(sandboxUrl)};

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

  toolSequence = 0;

  async stream(messages) {
    const last = messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const toolResult = blocks.find((block) => block?.type === 'tool_result');
    if (toolResult) {
      const content = typeof toolResult.content === 'string'
        ? toolResult.content
        : JSON.stringify(toolResult.content);
      if (!content.includes('Exit: 0') || !content.includes('runtime-sandbox-ok')) {
        throw new Error('Runtime sandbox Bash result was not successful: ' + content);
      }
      return {
        textBlocks: [{ type: 'text', text: 'done' }],
        toolBlocks: [],
        thinkingBlocks: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'end_turn',
      };
    }
    this.toolSequence += 1;
    return {
      textBlocks: [],
      toolBlocks: [{
        type: 'tool_use',
        id: 'runtime-sandbox-shell-' + this.toolSequence,
        name: 'bash',
        input: {
          command: "if ($env:ELECTRON_RUN_AS_NODE) { Write-Error 'Electron Node mode leaked'; exit 97 }; Write-Output 'runtime-sandbox-ok'",
        },
      }],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'tool_use',
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
let sandboxDoctor = await doctorKodaXSandbox({ refresh: true });
const directSandboxProbe = sandboxDoctor.ready
  ? await runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e',
        "if (process.env.ELECTRON_RUN_AS_NODE) process.exit(97); process.stdout.write('direct-sandbox-ok')",
      ],
      cwd: ${JSON.stringify(standaloneProbeDir)},
      filesystem: {
        allowRead: [dirname(process.execPath), ${JSON.stringify(standaloneProbeDir)}],
        allowWrite: [],
      },
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 15_000,
    })
  : undefined;
const directPowerShellProbe = sandboxDoctor.ready
  ? await runKodaXSandboxed({
      // Keep the external PowerShell child under the Electron Node target
      // already proven above. This avoids making Electron itself the outer
      // PowerShell target in the packaged smoke broker.
      command: process.execPath,
      args: [
        '-e',
        ${JSON.stringify(powerShellProbeScript)},
      ],
      cwd: ${JSON.stringify(standaloneProbeDir)},
      filesystem: {
        allowRead: [dirname(process.execPath), ${JSON.stringify(standaloneProbeDir)}],
        allowWrite: [],
      },
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 15_000,
    })
  : undefined;
writeFileSync(${JSON.stringify(environmentProofFile)}, JSON.stringify({
  daemon: process.env.ELECTRON_RUN_AS_NODE ?? 'absent',
  externalChild: child.stdout.trim(),
  externalChildStatus: child.status,
  externalChildError: child.error?.message,
  shellProbe: shellProbeOutput[0],
  shellProbeExitCode,
  shellProbeNodeMode: shellProbeOutput[1]?.replace(/^node-mode=/, ''),
  sandboxDoctor,
  directSandboxProbe,
  directPowerShellProbe,
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
