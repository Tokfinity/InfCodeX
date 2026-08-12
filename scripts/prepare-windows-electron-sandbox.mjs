#!/usr/bin/env node

import { setupKodaXSandbox } from '../dist/sdk-sandbox.js';

const doctor = await setupKodaXSandbox();
if (!doctor.ready) {
  throw new Error(
    `Windows sandbox preparation failed: ${JSON.stringify(doctor)}`,
  );
}

process.stdout.write(
  `Windows sandbox prepared for Electron smoke (ASRT ${doctor.version}).\n`,
);
