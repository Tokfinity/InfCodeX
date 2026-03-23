import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export async function createTempDir(prefix = "kodax-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (!dir) {
    return;
  }

  await rm(dir, { recursive: true, force: true });
}
