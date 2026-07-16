const fs = require('node:fs');

const { app } = require('electron');

const homeDir = requireEnvironment('KODAX_SMOKE_HOME');
const profile = requireEnvironment('KODAX_SMOKE_PROFILE');
const resultFile = requireEnvironment('KODAX_SMOKE_RESULT');
const detachFile = requireEnvironment('KODAX_SMOKE_DETACH');
const guiCountFile = requireEnvironment('KODAX_SMOKE_GUI_COUNT');

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

  const { connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
  const runtime = await connectKodaXRuntime({
    homeDir,
    profile,
    autoStart: true,
    clientInfo: { name: 'packaged-electron-smoke', instanceId: 'packaged-electron-smoke' },
    requirements: { daemonManagement: 1 },
  });
  const preflight = await runtime.status.preflight();
  writeResult({
    ok: true,
    appPid: process.pid,
    runtimeId: runtime.identity.runtimeId,
    clientCount: preflight.clientCount,
  });

  await waitForFile(detachFile, 90_000);
  await runtime.close();
  app.quit();
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
