import { MongoMemoryServer } from 'mongodb-memory-server';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Real-S3 profile (TEST_S3=garage): boot an actual garage server for the run
// so lib/util/storage-backend pushes real bytes over real S3 instead of the
// FileUtil stubs. Mirrors docker/garage/init.sh's single-node provisioning.
// The static musl binary is cached in node_modules (same trick as the
// mongodb-memory-server binaries) so re-runs don't re-download.
const GARAGE_VERSION = 'v1.0.1';
const GARAGE_S3_PORT = 3990;
const GARAGE_RPC_PORT = 3991;

async function startGarage() {
  const binDir = join(REPO_ROOT, 'node_modules', '.garage-binaries');
  const bin = join(binDir, 'garage-' + GARAGE_VERSION);
  if (!existsSync(bin)) {
    mkdirSync(binDir, { recursive: true });
    const url = 'https://garagehq.deuxfleurs.fr/_releases/' + GARAGE_VERSION +
                '/x86_64-unknown-linux-musl/garage';
    const res = await fetch(url);
    if (!res.ok) throw new Error('garage binary download failed: HTTP ' + res.status);
    writeFileSync(bin, Buffer.from(await res.arrayBuffer()));
    chmodSync(bin, 0o755);
  }

  const wd = mkdtempSync(join(tmpdir(), 'garage-test-'));
  const toml = join(wd, 'garage.toml');
  writeFileSync(toml, [
    'metadata_dir = "' + join(wd, 'meta') + '"',
    'data_dir = "' + join(wd, 'data') + '"',
    'db_engine = "lmdb"',
    'replication_factor = 1',
    'rpc_bind_addr = "127.0.0.1:' + GARAGE_RPC_PORT + '"',
    'rpc_public_addr = "127.0.0.1:' + GARAGE_RPC_PORT + '"',
    'rpc_secret = "' + randomBytes(32).toString('hex') + '"',
    '',
    '[s3_api]',
    'api_bind_addr = "127.0.0.1:' + GARAGE_S3_PORT + '"',
    's3_region = "garage"',
    'root_domain = ".s3.garage.localhost"',
    ''
  ].join('\n'));

  const server = spawn(bin, ['-c', toml, 'server'], { stdio: 'ignore' });
  const cli = (args) => spawnSync(bin, ['-c', toml].concat(args), { encoding: 'utf8' });
  const mustCli = (args) => {
    const r = cli(args);
    if (r.status !== 0) {
      server.kill();
      throw new Error('garage ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout));
    }
    return r;
  };

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    if (cli(['status']).status === 0) up = true;
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { server.kill(); throw new Error('garage server did not come up'); }

  // Single-node layout, one key, the five trinket buckets — init.sh's recipe.
  const nodeId = mustCli(['node', 'id', '-q']).stdout.trim().split('@')[0];
  mustCli(['layout', 'assign', '-z', 'dc1', '-c', '1G', nodeId]);
  mustCli(['layout', 'apply', '--version', '1']);

  const keyId  = 'GK' + randomBytes(12).toString('hex');
  const secret = randomBytes(32).toString('hex');
  mustCli(['key', 'import', keyId, secret, '-n', 'vitest', '--yes']);

  for (const b of ['materials', 'snapshots', 'useravatars', 'userassets', 'exports']) {
    mustCli(['bucket', 'create', 'trinket-' + b]);
    mustCli(['bucket', 'allow', '--read', '--write', '--owner', 'trinket-' + b, '--key', keyId]);
  }

  return {
    endpoint: 'http://127.0.0.1:' + GARAGE_S3_PORT,
    keyId: keyId,
    secret: secret,
    stop: () => { server.kill(); rmSync(wd, { recursive: true, force: true }); }
  };
}

// Vitest globalSetup: starts ONE in-process mongod for the whole run and
// hands its URI to workers via `provide` (process.env does NOT propagate).
export default async function ({ provide }) {
  // node-config 0.4 may have persisted a previous run's mutated config (e.g. a
  // firestore-profile run) to config/runtime.json, which outranks every other
  // config source and silently flips the backend. Remove it before workers load.
  rmSync(join(REPO_ROOT, 'config', 'runtime.json'), { force: true });

  const mongod = await MongoMemoryServer.create({ binary: { version: '6.0.14' } });
  provide('mongoUri', mongod.getUri());

  let garage = null;
  if (process.env.TEST_S3 === 'garage') {
    garage = await startGarage();
    provide('garage', { endpoint: garage.endpoint, keyId: garage.keyId, secret: garage.secret });
  } else {
    provide('garage', null);
  }

  return async () => {
    await mongod.stop();
    if (garage) garage.stop();
  };
}
