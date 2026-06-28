import { MongoMemoryServer } from 'mongodb-memory-server';

// Vitest globalSetup: starts ONE in-process mongod for the whole run and
// hands its URI to workers via `provide` (process.env does NOT propagate).
export default async function ({ provide }) {
  const mongod = await MongoMemoryServer.create({ binary: { version: '6.0.14' } });
  provide('mongoUri', mongod.getUri());
  return async () => { await mongod.stop(); };
}
