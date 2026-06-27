# Task 13 — Live Canvas-testbed validation of LTI Deep Linking + SpeedGrader review

The final gate before production for the **SP3** feature (LTI Deep Linking + LMS-grader submission
review). All code is built, reviewed (final whole-branch review = *Ready to merge, no
Critical/Important*), and committed on branch `lti-1.3` (range `f0dfe08..b53f879`, 17 commits). All 13
in-container unit suites are green. This is the only remaining step: prove it end-to-end against a
real Canvas.

- **Spec:** `docs/superpowers/specs/2026-06-22-lti-deeplinking-speedgrader-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-22-lti-deeplinking-speedgrader.md`
- **Registration mechanics:** `LTI-REGISTRATION.md` (existing) + the Canvas-local substitution table in
  `canvas-lti-testbed/canvas/RUNNING.md`

---

## What you're testing

| Increment | Success looks like |
|---|---|
| **A — Deep Linking** | From a Canvas assignment, the trinket **picker** appears; selecting an assignment makes Canvas create an external-tool assignment **with a gradebook column**. |
| **B1 — SpeedGrader review** | A student submits in trinket; the submission shows in **SpeedGrader** as "needs grading"; opening it re-launches trinket showing the student's work; the grade is entered **in SpeedGrader** (trinket stores no grade). |

---

## Prerequisites (one-time)

### 1. Get trinket running and reachable over public HTTPS

Canvas can't reach `localhost`, and the LTI iframe session needs `SameSite=None; Secure` (HTTPS).
Expose the local app via a tunnel and tell the app its public host:

```bash
cloudflared tunnel --url http://localhost:3001      # → https://<X>.trycloudflare.com  (or: ngrok http 3001)
export LTI_PUBLIC_HOST=<X>.trycloudflare.com LTI_PUBLIC_PROTO=https LTI_PUBLIC_PORT=null
cd ~/Development/glow-repos/trinket-gcr && docker compose up -d
curl https://<X>.trycloudflare.com/lti/jwks         # sanity → {"keys":[{ "kid": … }]}
```

> **KNOWN INFRA ISSUE (resolve first):** the `trinket-gcr` app container currently **exits on boot**
> (`exit 1`, "Firestore timed out after 5000ms" connecting to `firebase:8080`) — the app can't reach
> the Firestore emulator across the docker network even though the emulator answers on
> `localhost:8080` inside its own container. The full `docker compose up -d` (app + emulators) must
> bring the app up and keep it up before any live test is possible. If it still exits, debug the
> app→emulator connectivity (DNS/network/startup race on `firebase:8080`).
> NOTE: unit tests do NOT need this — they run in a keep-alive helper container `trinket-tests`
> (`--volumes-from trinket-gcr`); `docker rm -f trinket-tests` to remove it.

### 2. Bring the Canvas testbed up

```bash
cd ~/Development/canvas-lti-testbed/canvas && docker compose up -d   # Canvas at http://localhost:8080
```
(It was stopped to free port 8080 + RAM during development. See `canvas/RUNNING.md` if the DB needs
re-init.)

### 3. Register trinket via **Dynamic Registration** (not a manual Developer Key)

This matters: `ltiRegistration.buildToolConfiguration()` now auto-advertises the **Deep Linking
message**, the **`assignment_selection` + `link_selection`** placements, AND the **AGS score scope**.
Dynamic Registration wires all of that up automatically; a manual Developer Key would force you to
hand-add the placements + scopes in Canvas. Follow `LTI-REGISTRATION.md`; the admin must **activate**
the registration (it lands `pending` until approved in `/admin/lti-registrations`).

### 4. Create the trinket content first

The picker is **select-existing** (no inline create). In standalone trinket, create a **course** with
an **assignment** (a material of type `assignment`) so there's something to deep-link.

---

## The test

5. **Deep Linking (A):** In Canvas, create an assignment → Submission Type **External Tool** →
   **Find** → the trinket **picker** should appear → pick your assignment → Canvas creates the
   external-tool assignment **with a gradebook column**.
   *Pass: the column exists and the assignment launches trinket.*

6. **Student submit:** as a student, open the assignment → it launches trinket → do the work →
   **submit**. (Behind the scenes trinket posts a "submitted, pending-manual, no-score" AGS Score whose
   `submission_data` is `<host>/lti/review/<submissionId>`.)
   *Pass: trinket records the submission; no error on submit.*

7. **SpeedGrader review (B1):** as the instructor, open **SpeedGrader** for that assignment → the
   submission appears as "needs grading" → open it → Canvas re-launches trinket showing the student's
   work → enter a grade in SpeedGrader.
   *Pass: you see the actual trinket work inside SpeedGrader; the grade lands in the Canvas gradebook;
   trinket stored no numeric grade.*

---

## The one thing to watch (the dependency this test exists to confirm)

The SpeedGrader re-launch (step 7) carries **no custom params** — trinket resolves the course from the
**persisted `LtiResourceLink` mapping** for the assignment's `resource_link.id`. So step 7 depends on
**Canvas reusing the assignment's `resource_link.id`** on the review launch. If step 7 lands on
`/welcome` (or "this link isn't configured") instead of the submission, that dependency isn't holding
— watch trinket's logs (`docker logs -f trinket-gcr`) during step 7 to see the resolved target. This
is the single most valuable signal from the whole test.

---

## Troubleshooting

- **Picker doesn't appear (step 5):** confirm the registration advertised Deep Linking
  (`<host>/lti/jwks` reachable; the platform record is `active`); check trinket logs for the
  `LtiDeepLinkingRequest` reaching `/lti/launch`.
- **Submission doesn't show in SpeedGrader (step 7):** the AGS Score POST failed (it's best-effort and
  never blocks submit, so the student saw success regardless). Check trinket logs for
  `[lti] submission notify failed`. Likely causes: the platform `authTokenUrl` (token endpoint)
  unreachable, or the AGS scope not granted at registration.
- **Step 7 lands on /welcome:** the `resource_link.id` dependency above, or the assignment's
  `LtiResourceLink` mapping wasn't created (no student ever launched the assignment first).
- General LTI launch errors (`Unknown LTI issuer`, signature/JWKS, `Invalid or expired state`): see the
  troubleshooting list in `LTI-REGISTRATION.md`.

---

## After a successful run

- Update memory `project_lti_production_rollout` (SP3) from "pending live testbed" to "validated".
- The feature can then ride the `gcr-firebase` merge to production per the branch workflow (it is NOT
  merged to `main`; `lti-1.3` stays the accumulation branch).
