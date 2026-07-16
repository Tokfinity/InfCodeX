const fs = require('node:fs');
const path = require('node:path');

const { app } = require('electron');

const homeDir = requireEnvironment('KODAX_SMOKE_HOME');
const profile = requireEnvironment('KODAX_SMOKE_PROFILE');
const resultFile = requireEnvironment('KODAX_SMOKE_RESULT');
const detachFile = requireEnvironment('KODAX_SMOKE_DETACH');
const guiCountFile = requireEnvironment('KODAX_SMOKE_GUI_COUNT');
const environmentProofFile = requireEnvironment('KODAX_SMOKE_ENV_PROOF');

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
  const preflight = await runtime.status.preflight();
  writeResult({
    ok: true,
    appPid: process.pid,
    runtimeId: runtime.identity.runtimeId,
    clientCount: preflight.clientCount,
    environmentProof,
  });

  await waitForFile(detachFile, 90_000);
  await runtime.close();
  app.quit();
}

function prepareEnvironmentProbeExtension() {
  const configDir = path.join(homeDir, '.kodax');
  const extensionPath = path.join(homeDir, 'daemon-environment-probe.mjs');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(extensionPath, `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
  '/d', '/s', '/c',
  'if defined ELECTRON_RUN_AS_NODE (echo present) else (echo absent)',
], { encoding: 'utf8', windowsHide: true });
writeFileSync(${JSON.stringify(environmentProofFile)}, JSON.stringify({
  daemon: process.env.ELECTRON_RUN_AS_NODE ?? 'absent',
  externalChild: child.stdout.trim(),
  externalChildStatus: child.status,
  externalChildError: child.error?.message,
}), 'utf8');

export default function(api) {
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
    JSON.stringify({ extensions: [extensionPath] }),
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
