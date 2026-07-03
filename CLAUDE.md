# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

Trinket is an open-source, browser-based coding environment for education (Python, webVPython/GlowScript, HTML, Java, R, and more). This fork is maintained by a team of four collaborators who run it as a service for the physics and computer science teaching community. Upstream is `trinketapp/trinket-oss`; this repo periodically merges from `upstream/main` (see recent merge commits in git log).

## Commands

### Running the app

```bash
docker-compose up              # full stack: app, mongodb, redis, garage (S3-compatible storage)
docker-compose exec app npm run build:css   # rebuild SCSS -> public/css (one-time)
docker-compose exec app npm run watch:css   # rebuild on change
docker-compose restart app
docker-compose logs -f app
```

Without Docker: `npm install`, start MongoDB locally, then `node app.js`. Requires `config/local.yaml` (copy from `config/local.example.yaml`) with a 32+ char session cookie password, or the app refuses to boot (`app.js` validates this at startup).

Frontend vendor libraries (Ace, Skulpt, GlowScript/vpython, Blockly, etc., see COMPONENTS.md) are not in this repo — they're fetched as `public-components.tgz` from a GitHub release during the Docker build (see `Dockerfile`) and unpacked into `public/components/`. Local non-Docker dev needs that tarball unpacked manually.

### Tests

```bash
npm test                                   # mocha, runs test/**/*.js (see test/mocha.opts: --recursive --check-leaks)
npx mocha test/lib/api/course.js           # single file
npx mocha test/lib/api/course.js -g "some test name"   # single test by name
```

Tests boot the real `app.js` (`test/setup.js`) against MongoDB, with Redis mocked via `redis-mock` (`test/helpers/catbox-redis.js`). `test/helpers/db.js` handles per-test DB setup/teardown. `NODE_ENV=test` is set automatically by `test/setup.js`.

### Server-side language runners

Python3/Java/R/Pygame execute in separate Docker services under `serverside/` (not started by the root `docker-compose.yml`):

```bash
cd serverside
docker compose --profile python3 up --build      # add --profile java/r/pygame as needed
```

See `serverside/README.md` for the manager/shell architecture and per-language config.

## Architecture

**Stack:** Node.js + Hapi 20 (backend), MongoDB/Mongoose (data), Redis (optional cache/sessions, falls back to in-memory), AngularJS 1.x (frontend), Nunjucks (server-rendered templates), Skulpt (in-browser Python compiler).

### Request flow / routing

Routes are declared as compact DSL strings, not standard Hapi route objects — e.g. `'GET /login pages.login'` combines method, path, and a `controller.method` reference in one string. `config/routes.js` (page routes) and `config/api_routes.js` (JSON API) both use this format; `lib/util/routeParser.js` parses the string and wires it to the corresponding function in `lib/controllers/*.js`. When tracing a route, start from the DSL string, not a conventional `server.route()` call.

Session auth is a custom Hapi scheme (`session`) registered directly in `app.js`, backed by `@hapi/yar` server-side sessions stored in MongoDB (via `lib/util/catbox-mongoose.js`). Auth mode is `try` by default (guest access allowed; `config: { auth: 'session' }` per-route requires login). Google OAuth is handled separately via Passport (`lib/auth/passport.js`).

### Models

`lib/models/model.js` is a factory (`createModel`) wrapping Mongoose schemas — all models in `lib/models/*.js` (User, Course, Lesson, Trinket, Folder, etc.) are built through it rather than calling `mongoose.model()` directly. It auto-adds `findById`/`findByIds`/`findByIdAndUpdate` class methods, timestamp fields, and a `serialize()`/`publicSpec()` pair for controlling what a document exposes to the client. Cross-cutting schema behavior (ownership, roles, slugs, pagination, ordered lists) lives in `lib/models/plugins/*.js` and is attached via each model's `plugins` config. Models are loaded as **globals** in `app.js` (`User`, `Course`, `Trinket`, etc.) for backwards compatibility — controllers reference them without `require`.

### Data access layer

`lib/util/store/*.js` (courseStore, trinketStore, userStore, emailStore, featuredStore) sit between controllers and models for query logic that's reused across controllers/routes — check there before adding a new query helper to a controller.

### Background work

`lib/workers/exports.js` is a Bull/Redis queue worker for bulk export jobs (`lib/util/queues.js` defines the queue). In production it runs as a separate process; for local/test stacks it can run in-process by setting `RUN_EXPORT_WORKER=true`, which `app.js` uses to `require` it only after server init completes (required earlier, it mis-compiles validation schemas — see comment in `app.js`).

### Frontend

AngularJS 1.x, module-per-feature under `public/js/` (`classPage`, `courseEditor`, `embed`, `components`, `services`, `library`, `plugins`). `public/js/app.js` defines the root `trinket.main` module aggregating feature modules. Server-rendered pages (Nunjucks, `lib/views/`) bootstrap Angular; embeds (`/embed/python`, `/embed/glowscript`, etc.) are separate lighter-weight entry points — see `public/js/embed/` and COMPONENTS.md for which vendored library backs each embed type (Skulpt for Python, GlowScript/vpython-glowscript for webVPython, Blockly for the blocks editor).

CSS is SCSS compiled via Vite (`vite.config.mjs`) — note this is CSS-only bundling; Vite is not used for JS. Entry points: `static/scss/base.scss` and `static/scss/embed/embed.scss`, output to `public/css/`.

### Configuration

`node-config`-based, layered YAML in `config/`: `default.yaml` (committed base) → `local.yaml` (gitignored local overrides) → `production.yaml` (gitignored). `config/app.config.js` and `config/constants.js` do further JS-side setup on top of the YAML. Feature flags (which trinket types are enabled, courses, assets, etc.) live under `features:` in these YAML files — check them when a feature seems to be "missing" rather than assuming it's unimplemented.

### Docker services (root `docker-compose.yml`)

`app` (this codebase), `mongodb`, `redis`, and `garage` (self-hosted S3-compatible object storage, used for user-uploaded assets in place of AWS S3 in local/self-hosted dev — `garage-init` bootstraps its buckets). This is distinct from the `serverside/` compose stack, which runs the actual language-execution containers.
