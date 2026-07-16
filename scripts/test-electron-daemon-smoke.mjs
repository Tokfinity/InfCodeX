#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDist = requirePath('KODAX_ELECTRON_DIST');
const electronBuilderCli = requirePath('KODAX_ELECTRON_BUILDER_CLI');
const electronPackage = JSON.parse(await readFile(path.join(electronDist, '..', 'package.json'), 'utf8'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-electron-daemon-smoke-'));
const appDir = path.join(temporaryRoot, 'app');
const homeDir = path.join(temporaryRoot, 'home');
const profile = `electron-smoke-${process.pid}-${Date.now()}`;
let electronProcess;
let electronSpawnError;
const electronOutput = [];

try {
  await preparePackagedApplication(electronPackage.version);
  const executable = path.join(appDir, 'release', 'win-unpacked', 'kodax-daemon-smoke.exe');
  assert.ok(existsSync(executable), `Packaged Electron executable is missing: ${executable}`);
  const resultFile = path.join(temporaryRoot, 'result.json');
  const detachFile = path.join(temporaryRoot, 'detach');
  const guiCountFile = path.join(temporaryRoot, 'gui-count.txt');
  electronProcess = startElectron(executable, { resultFile, detachFile, guiCountFile });

  // Let the SDK's 60-second cold-start budget report its own structured failure
  // before the harness times out, including on slow CI/antivirus hosts.
  const result = await waitForJson(resultFile, 75_000);
  assert.deepEqual(result.ok, true, result.error ?? 'Packaged Electron startup failed.');
  assert.equal(result.clientCount, 1, 'The packaged facade must be the only logical client after cold start.');
  const sdk = await importInstalledRuntimeSdk();
  await verifyAttachDetachAndOwnerFence(sdk, result.runtimeId, detachFile, guiCountFile);
  await waitForExit(electronProcess, 15_000);
  process.stdout.write(`Packaged Electron daemon smoke passed for Electron ${electronPackage.version}.\n`);
} finally {
  if (electronProcess?.exitCode === null) electronProcess.kill();
  await stopDaemonBestEffort();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function preparePackagedApplication(electronVersion) {
  const fixture = path.join(repoRoot, 'tests', 'fixtures', 'electron-daemon-smoke');
  await cp(fixture, appDir, { recursive: true });
  const packOutput = await runNpm(['pack', '--pack-destination', temporaryRoot, '--json'], repoRoot);
  const [{ filename }] = JSON.parse(packOutput);
  await runNpm([
    'install', '--save-exact', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    path.join(temporaryRoot, filename),
  ], appDir, 300_000);
  await writeFile(
    path.join(appDir, 'electron-builder.json'),
    JSON.stringify(createBuilderConfig(electronVersion), null, 2),
    'utf8',
  );
  await run(process.execPath, [electronBuilderCli, '--dir', '--win', '--x64', '--config', 'electron-builder.json'], appDir, 300_000);
}

function createBuilderConfig(electronVersion) {
  return {
    appId: 'ai.kodax.daemon.smoke',
    productName: 'KodaXDaemonSmoke',
    electronVersion,
    electronDist,
    asar: true,
    npmRebuild: false,
    directories: { output: 'release' },
    files: ['main.cjs', 'package.json', 'node_modules/**/*'],
    win: { target: 'dir', executableName: 'kodax-daemon-smoke', signAndEditExecutable: false },
  };
}

function startElectron(executable, files) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...parentEnvironment } = process.env;
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: {
      ...parentEnvironment,
      KODAX_SMOKE_HOME: homeDir,
      KODAX_SMOKE_PROFILE: profile,
      KODAX_SMOKE_RESULT: files.resultFile,
      KODAX_SMOKE_DETACH: files.detachFile,
      KODAX_SMOKE_GUI_COUNT: files.guiCountFile,
      KODAX_TRACING: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => electronOutput.push(chunk));
  child.stderr.on('data', (chunk) => electronOutput.push(chunk));
  child.once('error', (error) => { electronSpawnError = error; });
  return child;
}

async function importInstalledRuntimeSdk() {
  const entry = path.join(appDir, 'node_modules', '@kodax-ai', 'kodax', 'dist', 'sdk-runtime.js');
  return import(pathToFileURL(entry).href);
}

async function verifyAttachDetachAndOwnerFence(sdk, runtimeId, detachFile, guiCountFile) {
  const attached = await sdk.connectKodaXRuntime({
    homeDir,
    profile,
    autoStart: false,
    clientInfo: { name: 'node-smoke', instanceId: 'node-smoke' },
    requirements: { daemonManagement: 1 },
  });
  assert.equal(attached.identity.runtimeId, runtimeId);
  await waitForClientCount(attached, 2);
  await attached.close();
  await writeFile(detachFile, 'detach', 'utf8');
  await waitForExit(electronProcess, 15_000);
  assert.equal((await readFile(guiCountFile, 'utf8')).trim().split(/\r?\n/).length, 1);

  const management = await sdk.connectKodaXRuntime({ homeDir, profile, autoStart: false, requirements: { daemonManagement: 1 } });
  assert.equal(management.identity.runtimeId, runtimeId, 'Electron close must detach without stopping the daemon.');
  await waitForClientCount(management, 1);
  await stopForInline(management);
  await management.close();
  await waitForUnowned(sdk);
  assert.equal(sdk.enableKodaXDaemonOwner({ homeDir, profile }).mode, 'daemon');

  const restarted = await sdk.connectKodaXRuntime({ homeDir, profile, autoStart: true, requirements: { daemonManagement: 1 } });
  assert.notEqual(restarted.identity.runtimeId, runtimeId);
  await waitForClientCount(restarted, 1);
  await stopForInline(restarted);
  await restarted.close();
  await waitForUnowned(sdk);
  assert.equal(sdk.enableKodaXDaemonOwner({ homeDir, profile }).mode, 'daemon');
}

async function stopForInline(runtime) {
  const state = await runtime.daemon.inspect();
  await runtime.daemon.stopForInline({
    expectedRuntimeId: state.runtimeId,
    expectedRevision: state.revision,
    expectedOwnerPolicyRevision: state.ownerPolicy.revision,
  });
}

async function waitForClientCount(runtime, expected) {
  await waitUntil(async () => (await runtime.status.preflight()).clientCount === expected, 30_000, `clientCount=${expected}`);
}

async function waitForUnowned(sdk) {
  await waitUntil(
    () => sdk.getKodaXRuntimeOwnerState({ homeDir, profile }).ownerStatus === 'unowned',
    30_000,
    'an unowned Runtime fence',
  );
}

async function waitForJson(file, timeoutMs) {
  let value;
  await waitUntil(async () => {
    if (!existsSync(file)) return false;
    value = JSON.parse(await readFile(file, 'utf8'));
    return true;
  }, timeoutMs, `result file ${file}`, electronFailure);
  return value;
}

function electronFailure() {
  if (electronSpawnError) return electronSpawnError;
  if (electronProcess?.exitCode === null || electronProcess === undefined) return undefined;
  const output = Buffer.concat(electronOutput).toString('utf8').trim();
  return new Error(
    `Packaged Electron exited with code ${electronProcess.exitCode} before reporting ready.`
    + (output ? `\n${output}` : ''),
  );
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for process ${child.pid} to exit.`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntil(predicate, timeoutMs, description, earlyFailure = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    const failure = earlyFailure();
    if (failure) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function run(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

function runNpm(args, cwd, timeoutMs) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error('npm_execpath must identify the npm CLI entry for the packaged Electron smoke.');
  }
  return run(process.execPath, [npmCli, ...args], cwd, timeoutMs);
}

async function stopDaemonBestEffort() {
  const cli = path.join(repoRoot, 'dist', 'kodax_cli.js');
  if (!existsSync(cli)) return;
  try {
    await run(process.execPath, [cli, 'daemon', 'stop', '--home', homeDir, '--profile', profile, '--timeout-ms', '3000', '--json'], repoRoot, 10_000);
  } catch (error) {
    process.stderr.write(`[electron-daemon-smoke] cleanup warning: ${String(error)}\n`);
  }
}

function requirePath(name) {
  const value = process.env[name];
  if (!value || !existsSync(value)) throw new Error(`${name} must point to an existing path.`);
  return path.resolve(value);
}
