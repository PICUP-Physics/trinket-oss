# GCP testbed bring-up runbook — Canvas + trinket-gcr on one VM, tunnel-exposed

Stand up the full LTI testbed (Canvas LMS + trinket-gcr + Firestore emulators) on a single
Google Compute Engine VM, so testing is independent of your laptop. trinket is exposed to the
public internet via a **cloudflared tunnel** (required: Canvas's server fetches trinket's JWKS and
the browser redirects to it); Canvas stays **private** and you reach its UI via an SSH port-forward.

This mirrors the existing local setup exactly — Canvas on `localhost:8080`, trinket on a public
tunnel, server-to-server via `host.docker.internal` — so the registration substitution table in the
testbed `canvas/RUNNING.md` applies unchanged.

> **Decisions baked in:** machine `e2-standard-4`, public HTTPS via **cloudflared tunnel**, Firestore
> host port `8088` (already in `docker-compose.yml`). Steps you must run yourself (auth/login) are
> marked **[you]** — prefix them with `!` in the Claude Code prompt so their output lands in session.

---

## 0. Prerequisites (one-time, on your Mac)

- `gcloud` CLI installed and a GCP project with **billing enabled**.
- **[you]** Authenticate: `! gcloud auth login` and `! gcloud config set project <YOUR_PROJECT>`.
- Pick a zone near you, e.g. `us-central1-a` (substitute `<ZONE>` below).

---

## 1. Create the VM

```bash
gcloud compute instances create trinket-testbed \
  --zone=<ZONE> \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced
```

No firewall rules needed for the testbed itself: the cloudflared tunnel is **outbound** (no inbound
443), and Canvas is reached over the SSH tunnel (gcloud SSH uses Google's IAP/SSH path). Keep the VM's
public surface closed.

**Cost lever:** `gcloud compute instances stop trinket-testbed --zone=<ZONE>` between sessions →
you pay only for the ~50 GB disk (~$2–4/mo). `start` again in seconds.

---

## 2. Install Docker on the VM

```bash
gcloud compute ssh trinket-testbed --zone=<ZONE> --command '
  sudo apt-get update &&
  curl -fsSL https://get.docker.com | sudo sh &&
  sudo usermod -aG docker $USER
'
# log out/in (or reconnect) so the docker group applies
```

---

## 3. Get the code + images onto the VM

### Canvas testbed (public)
```bash
gcloud compute ssh trinket-testbed --zone=<ZONE> --command '
  git clone https://github.com/sspickle/lti-testbeds.git &&
  docker pull ghcr.io/sspickle/canvas-current:local &&
  docker tag ghcr.io/sspickle/canvas-current:local canvas-current:local
'
```
The Canvas image is `linux/amd64` — it runs **natively** on the VM (no Rosetta), which is faster and
is the most likely place the Mac's app↔emulator boot timeout simply does not occur.

### trinket-gcr (private — needs repo access + secrets)
- Clone trinket-gcr on the VM (use your auth to the trinket-gcr remote).
- **Secrets must NOT come from the public repo.** Copy these to the VM out-of-band (e.g. `gcloud compute scp`
  from your Mac, or GCP Secret Manager) — never commit or print them:
  - `firebase-service-account.json`
  - the `.env` values the compose file reads: `SESSION_PASSWORD`, `GOOGLE_CLIENT_ID`,
    `GOOGLE_CLIENT_SECRET`, `FIREBASE_CLIENT_CONFIG`, `LTI_PRIVATE_KEY`
- Example secret copy (run from the Mac):
  ```bash
  gcloud compute scp ./.env trinket-testbed:~/trinket-gcr/.env --zone=<ZONE>
  gcloud compute scp ./firebase-service-account.json trinket-testbed:~/trinket-gcr/ --zone=<ZONE>
  ```

### Build the trinket app image for amd64 (drop the arm64 pin)
The committed `docker-compose.yml` pins the app to `linux/arm64` (Mac-specific). On the amd64 VM,
remove or change that pin **on the VM's checkout only** (don't commit this VM-local change):

```yaml
# docker-compose.yml on the VM — app service
app:
  # platform: linux/arm64        ← delete this line (or set linux/amd64) on the VM
```
Then the normal `docker compose build` / `up` builds it natively for amd64.

---

## 4. Bring both stacks up

```bash
# Canvas (host 8080 on the VM)
cd ~/lti-testbeds/canvas && docker compose up -d
#   first time only: DB init per canvas/RUNNING.md (db:create → db:initial_setup → db:migrate)

# trinket (Firestore already remapped to host 8088; app on 3001)
cd ~/trinket-gcr && docker compose up -d
```

The `8088` Firestore remap means Canvas (`8080`) and trinket's emulator no longer collide on the VM —
same fix as on the Mac.

---

## 5. Expose trinket via cloudflared tunnel

Run cloudflared **on the VM**, pointing at the trinket app:

```bash
# on the VM
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o cloudflared && chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3001      # → https://<X>.trycloudflare.com
```

Tell the app its public host, then restart it so the LTI URLs are correct:
```bash
export LTI_PUBLIC_HOST=<X>.trycloudflare.com LTI_PUBLIC_PROTO=https LTI_PUBLIC_PORT=null
cd ~/trinket-gcr && docker compose up -d
curl https://<X>.trycloudflare.com/lti/jwks        # sanity → {"keys":[{ "kid": … }]}
```

Why trinket must be public: Canvas's **server** fetches trinket's `/lti/jwks` (to verify the Deep
Linking Response JWT and the `private_key_jwt` client assertion), and the browser is redirected to
trinket during launch. trinket→Canvas calls (OIDC auth, token, AGS) go the other way and stay inside
the VM via `host.docker.internal:8080` — so Canvas does not need to be public.

---

## 6. Reach the Canvas UI from your browser (SSH port-forward)

Keep Canvas private; tunnel its UI to your Mac over SSH:

```bash
# on your Mac — leave this running while you test
gcloud compute ssh trinket-testbed --zone=<ZONE> -- -N -L 8080:localhost:8080
# now http://localhost:8080 in your Mac browser hits Canvas on the VM
```

Canvas's own base URL stays `http://localhost:8080`, so its `iss` and the `host.docker.internal:8080`
substitutions in `canvas/RUNNING.md` are **identical to the local setup** — no registration-table
changes. (If you'd rather not hold an SSH session open, a second cloudflared tunnel for `:8080` also
works, but then Canvas's `iss` becomes the tunnel host and the substitution table must be updated to
match — SSH forward is the lower-friction path.)

---

## 7. Register + run the test

From here it is the same as on the Mac: Dynamic Registration per `LTI-REGISTRATION.md`, then the
deep-link → student-submit → SpeedGrader-review flow in `TASK13.md`. The trinket public host is the
cloudflared URL from step 5; Canvas is `localhost:8080` via the SSH forward from step 6.

---

## Teardown / pause

- **Pause (keep state, near-zero cost):** `gcloud compute instances stop trinket-testbed --zone=<ZONE>`.
- **Resume:** `start`, reconnect, `docker compose up -d` in both dirs, restart the tunnel (a new
  `trycloudflare.com` host each time unless you set up a named tunnel), re-export `LTI_PUBLIC_HOST`,
  and (if the tunnel host changed) re-run Dynamic Registration.
- **Destroy entirely:** `gcloud compute instances delete trinket-testbed --zone=<ZONE>`.

> A **named** cloudflared tunnel (with a stable hostname) avoids re-registering every resume — worth
> setting up if this becomes a persistent shared testbed rather than a throwaway.

---

## What's still open / known issues

- **App boot timeout** (`TASK13.md` step 1): if it persists even on native amd64, it's a real
  app↔emulator startup/connectivity bug to debug, not an emulation artifact. The VM is the cleanest
  place to tell those two causes apart.
- **Secrets hygiene:** the trinket private key, `firebase-service-account.json`, and the Canvas
  `config/*.yml` keys must never reach the public repos. Move them out-of-band (scp / Secret Manager).
