import { MongoMemoryServer } from 'mongodb-memory-server';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Vitest globalSetup: starts ONE in-process mongod for the whole run and
// hands its URI to workers via `provide` (process.env does NOT propagate).
export default async function ({ provide }) {
  // node-config 0.4 may have persisted a previous run's mutated config (e.g. a
  // firestore-profile run) to config/runtime.json, which outranks every other
  // config source and silently flips the backend. Remove it before workers load.
  rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'runtime.json'), { force: true });

  const mongod = await MongoMemoryServer.create({ binary: { version: '6.0.14' } });
  provide('mongoUri', mongod.getUri());
  return async () => { await mongod.stop(); };
}
