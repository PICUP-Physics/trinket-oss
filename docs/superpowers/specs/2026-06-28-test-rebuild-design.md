# Test Rebuild — Design Spec

- **Date:** 2026-06-28
- **Branch:** `tests/rebuild` (worktree `trinket-tests`, based on `picup/main`)
- **Status:** draft for review

## Goal

Rebuild trinket-oss's test suite into a trustworthy set of **unit**, **backend-contract**, and **integration** tests, with a **TDD workflow** and **CI**, mergeable to `picup/main` — giving confidence the app works whether deployed on **MongoDB** (picup) or **Firestore** (our GCR fork).

## Hard constraints

1. **Backend-neutral merge.** Merging to `picup/main` must NOT change picup's runtime backend. picup deploys on MongoDB (mongoose), unchanged. `config.db.backend` default stays `mongoose`; the test work never alters runtime backend selection.
2. **No forced data migration / server upgrade.** The Node-20 bump must not force a mongoose major bump, a Mongo-server upgrade, or any data migration for picup. *(Verified: both forks already run `mongoose ^6` against a Mongo 5-era server, and the fork already runs mongoose 6 on Node 20 — the bump is data-safe.)*
3. **Mergeable to picup/main.** Framework + unit + integration + the contract-vs-Mongo leg are all picup-mergeable. The contract-vs-Firestore leg lives in our fork (where the Firestore backend exists), riding the same shared contract.

## Key facts (from recon)

- **Existing suite:** ~26 mocha test files (models, API routes, util, plugins) on ancient deps — mocha `3.4`, chai `3.5`, sinon `1.7`, supertest `0.8`. No CI; no Node pin; Mongo-only (`test/helpers/db.js`).
- **Versions:** picup/main and the fork are both on `mongoose ^6.0.0`; the fork runs it on **Node 20**. Mongo server: `mongo:5`. picup `Dockerfile` = `node:16-bullseye`; fork = `node:20-bullseye`.
- **Why the fork is on Node 20:** Firestore/Firebase deps (`firebase-admin ^13` needs Node ≥18, plus `@google-cloud/firestore ^8`, `@google-cloud/storage ^7`).
- **DB abstraction:** `lib/db/backend-factory.js` → `getBackend().createModel(name, schema)`. `mongoose-backend.js` is thin (`mongoose.model`); `firestore-backend.js` is a ~40KB shim that re-implements the mongoose model API. Models use a mongoose-style API: `find` / `$in` / `sort` / `limit` / `select` / `exec` / `save` + schema validation.

## Decisions

- **Runtime:** Node 20 on both forks. picup's only runtime-facing change is `node 16 → 20` + dev-deps. (Vitest also needs Node ≥18, so this is required regardless.) Pin via `.nvmrc` + `engines`.
- **Framework:** **Vitest** — fast watch mode (the TDD inner loop), built-in assertions/mocks/coverage. Replaces mocha/chai/sinon.
- **DB harness (no external services):** `mongodb-memory-server` (in-process Mongo) for Mongo tests; the **Firestore emulator** for the Firestore contract leg (fork only).
- **Three layers:**
  - **Unit** — model/controller/util logic with the DB stubbed. Fast; the bulk; the red-green loop.
  - **Backend contract suite** — exercises the `createModel` model API, run against **both** backends. The parity guarantee; directly exercises the Firestore shim.
  - **Integration** — a focused set of real route→model→backend flows on Mongo.
- **CI (new — none exists today):** GitHub Actions. picup: unit + integration + contract-vs-Mongo on every push/PR. Fork: adds contract-vs-Firestore (emulator). Coverage reported; threshold starts low and ratchets up; CI gate blocks merges on red.
- **TDD workflow:** red → green → refactor. The contract suite doubles as the backend spec (write the contract, make each backend pass). New features start with a failing unit test.

## Sequencing (each a mergeable slice)

1. **Rails:** Node 20 bump + Vitest scaffold + one trivial green test + GitHub Actions CI; validate `npm ci` + app boot on Node 20.
2. **Port high-value tests:** models + key API routes → Vitest, using `mongodb-memory-server`.
3. **Backend contract suite:** define the contract; Mongo passes (picup), then Firestore passes (fork).
4. **Integration flows + coverage ratchet.**

## Merge strategy

Slices 1–3 (mongoose) → PR(s) to `picup/main` (backend-neutral, Node 20, Vitest). The Firestore contract leg stays in our fork on the same shared contract.

## Non-goals

- Changing picup's runtime DB backend.
- Migrating data or upgrading the Mongo server.
- 100% coverage on day one (ratchet up over time).
- Refactoring app logic beyond what's needed to make it testable (targeted, in-the-course-of-work improvements only).

## Open questions

- Exact Node 20 minor to pin.
- Coverage threshold starting point + ratchet cadence.
- Whether the Node-20 bump surfaces other stale picup deps (validated in slice 1).
- One PR vs a small stack of PRs to picup (node bump → vitest scaffold → ported tests → contract).
