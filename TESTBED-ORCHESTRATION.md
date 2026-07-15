# Running Canvas + trinket-gcr together — port plan & cloud-host option

Two questions, answered for the AFK reader:

1. **How do we run the Canvas testbed and the gcr trinket app locally at the same time without port conflicts?**
2. **Could a Google Cloud instance host this so the laptop is free and we can work independently of it?**

---

## Part 1 — The port situation (and the one-line fix)

### What actually collides

| System | Host ports it publishes | Notes |
|---|---|---|
| **Canvas testbed** (`~/Development/canvas-lti-testbed/canvas`) | **`8080`** → container `:80` (nginx/web) | postgres + redis publish **no** host ports (internal only) |
| **trinket-gcr** (`docker-compose.yml`) | `4000` (emulator UI), **`8080`** (Firestore), `9099` (Auth), `9199` (Storage), `3001` (app) | |

**The only conflict is port `8080`.** Canvas wants it for its web UI; trinket publishes it for the Firestore emulator.

### Why this is trivial to fix

The trinket **app does not use the host-published `8080`**. It talks to Firestore over the internal docker network:

```yaml
FIRESTORE_EMULATOR_HOST: firebase:8080   # container DNS name + container-internal port
```

The `8080:8080` line in trinket's compose only exists so a *human on the host* can poke Firestore directly — and we already learned (memory: "Emulator port collision") that the host `localhost:8080` is unreliable and we inspect Firestore from *inside* the container instead. So the host publish of `8080` is effectively dead weight, and remapping or dropping it changes nothing for the app or the emulator UI (the UI at `:4000` proxies to Firestore inside the same container, also not via the host port).

### Fix (applied): direct one-line edit to `docker-compose.yml`

In `docker-compose.yml`, the Firestore publish was changed from `8080:8080` to `8088:8080`:

```yaml
firebase:
  ports:
    - "4000:4000"   # Emulator UI
    - "8088:8080"   # Firestore — host 8088 instead of 8080 (container port unchanged)
    - "9099:9099"   # Auth
    - "9199:9199"   # Storage
```

- The container-internal port stays `8080`, so `FIRESTORE_EMULATOR_HOST: firebase:8080` is unchanged — **no app config edit needed**.
- Canvas keeps `8080` for its web UI.
- If you ever want host access to Firestore, it's now `localhost:8088`.

**Why a direct edit and not a `docker-compose.override.yml`:** Compose **concatenates** the `ports` list across base + override files instead of replacing it, so an override adding `8088:8080` would leave the base `8080:8080` in place and *re-create* the collision. Editing the committed file is the robust, version-independent fix — and it's correct in every environment, because the Mac *and* the cloud VM both run Canvas alongside trinket, so `8088` is universally right. No colleague runs trinket's compose without Canvas in a way that needs host `8080`.

### Startup order on the Mac (both at once)

```bash
# 1. Canvas (keeps 8080)
cd ~/Development/canvas-lti-testbed/canvas && docker compose up -d
# 2. trinket (Firestore now on host 8088 via the override; app unaffected)
cd ~/Development/glow-repos/trinket-gcr && docker compose up -d
# Canvas:   http://localhost:8080
# trinket:  http://localhost:3001   (public HTTPS via cloudflared for LTI — see TASK13.md)
```

### One caveat unrelated to ports

The trinket **app container's boot failure** (exit 1, "Firestore timed out after 5000ms" reaching `firebase:8080`) is a *separate* problem from the port collision — it's an app↔emulator startup/connectivity issue on the arm64 Mac, flagged in `TASK13.md` step 1. Fixing the port conflict does **not** fix that; it still needs debugging before a live end-to-end test. (See Part 2 — it may simply not reproduce on a native-amd64 host.)

---

## Part 2 — Hosting it on Google Cloud (yes, and here's the shape)

**Short answer: yes.** A single GCE VM running Docker can host *both* Canvas and trinket via their existing compose files, leaving your laptop free. You'd SSH in (or hand me commands to run), and Canvas/trinket are reachable from any browser. This is the right tool — **not** Cloud Run, which can't host Canvas (stateful Postgres, long-running, multi-container).

### Why a VM is a good fit here

- **Native amd64.** Canvas's image is `linux/amd64` (runs under Rosetta on your Mac today). On an amd64 VM it runs *natively* — faster, and the arm64-emulation flakiness that may be behind the app↔emulator boot timeout likely disappears.
- **Co-location.** Both stacks on one VM reach each other over docker networking exactly like they do on the Mac — the same `host.docker.internal` / internal-DNS substitution already documented in the testbed `RUNNING.md` applies.
- **Laptop-independent.** The VM stays up regardless of your laptop. Work continues whether the lid is open or not.

### What needs to change to move trinket to amd64

trinket's `docker-compose.yml` pins the **app** service to arm64:

```yaml
app:
  platform: linux/arm64    # ← Mac-specific; remove or set linux/amd64 on a GCP VM
  image: trinket-gcr/app:latest
```

On an amd64 VM, drop that pin (or set `linux/amd64`) and rebuild the app image for amd64. You already build amd64 images on your cloud Linux box (memory: "Heavy build workflow"), so this is a known path — or just build it on the VM itself. The emulator image (`Dockerfile.emulator`) and Canvas image are already amd64-friendly.

### The LTI HTTPS requirement still applies

Canvas must reach trinket over public HTTPS with `SameSite=None; Secure`. Two ways on a VM:

| Option | How | Best for |
|---|---|---|
| **cloudflared tunnel from the VM** | Same as today, just run it on the VM instead of the Mac | Quick, no DNS/cert work, ephemeral testing |
| **Real domain + Caddy/nginx + Let's Encrypt** | Point a hostname at the VM's static IP, open `443`, terminate TLS | A persistent shared testbed others can hit by URL |

Server-to-server calls (OIDC, JWKS, token endpoint) between Canvas and trinket stay on the VM's internal/docker names; only the browser-facing URLs need the public host — identical to the local substitution table you already wrote.

### Sizing & cost (rough)

Canvas is RAM-hungry; add trinket + three emulators on top.

| Machine | vCPU / RAM | ~On-demand cost | Verdict |
|---|---|---|---|
| `e2-standard-2` | 2 / 8 GB | ~$0.067/hr (~$49/mo always-on) | Tight; probably the floor, may swap |
| `e2-standard-4` | 4 / 16 GB | ~$0.134/hr (~$98/mo always-on) | **Recommended** comfortable baseline |
| `e2-standard-8` | 8 / 32 GB | ~$0.27/hr (~$196/mo always-on) | Roomy; only if both stacks feel cramped |

**Cost control that matters:** you almost never need it always-on. **Stop the VM when not testing** → you pay only for the persistent disk (~50 GB ≈ $2–4/mo). A start/stop is seconds. For purely ephemeral runs, a **Spot VM** is ~60–70% cheaper but can be preempted — fine for a throwaway testbed, annoying if mid-session.

### A zero-new-cost alternative

You already have an **amd64 cloud Linux box** for builds (`exouser@149.165.168.249`, Jetstream/ACCESS — *not* GCP). It can run the testbed too, if it can stay up and expose a tunnel. That avoids spinning up (and paying for) a GCP VM entirely. Trade-off: it's your build box, so running a persistent stateful Canvas there mixes concerns; a dedicated GCP VM keeps the testbed isolated and disposable.

### Recommendation

1. **Immediate / free:** add the `docker-compose.override.yml` remap (Part 1) and run both on the Mac. Solves the stated port problem today.
2. **If the Mac app↔emulator boot issue persists or you want the laptop free:** stand up an **`e2-standard-4` GCE VM**, drop the arm64 pin + rebuild the app for amd64, run both compose stacks, expose trinket via cloudflared (or a domain if it becomes a shared resource), and **stop the VM between sessions**. The native-amd64 environment is also the most likely place the boot timeout simply doesn't happen.

---

## Open decisions for when you're back

- **Port fix scope:** just the `8088` Firestore remap (recommended), or remap *all* trinket host ports into an `808x`/`90xx` block to bulletproof against future collisions?
- **Cloud or not:** stay Mac-local for now, or invest the ~1–2 hrs to stand up the GCP VM so testing is laptop-independent? (I can write the full VM bring-up runbook — VM create, Docker install, amd64 app rebuild, both stacks up, tunnel — as a follow-up doc whenever you want it.)
- **If cloud: tunnel vs domain** for the public HTTPS that LTI requires.
