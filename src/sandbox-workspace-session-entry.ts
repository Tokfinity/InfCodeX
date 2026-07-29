import { runAsrtWorkspaceSessionProcess } from './sandbox-runtime.js';

const initFile = process.argv[2];
if (!initFile) throw new Error('Missing ASRT workspace session initialization file.');

process.exitCode = await runAsrtWorkspaceSessionProcess(initFile);
