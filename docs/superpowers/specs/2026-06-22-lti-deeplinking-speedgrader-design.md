# LTI Deep Linking + LMS-grader Submission Review — design

- **Date:** 2026-06-22
- **Status:** DESIGN — approved in brainstorming; ready for an implementation plan (`writing-plans`).
- **Branch:** `lti-1.3`
- **Builds on:** the v1 LTI launch (`LTI-SPEC.md`). This is the **LTI Advantage** layer that v1 §2
  explicitly deferred (Deep Linking + a minimal slice of AGS).

## 1. Goal

Let an instructor, **from inside their LMS**:

1. **Deep Linking (A):** place a trinket **assignment** (and, second, a **course/topic** link) by
   picking it from a trinket-rendered picker — no hand-copying a `trinket_course` id into a custom
   field.
2. **Submission review in the LMS grader (B1):** review a student's submitted trinket **inside the
   LMS grading tool** (Canvas SpeedGrader) and record the grade **in the LMS** — trinket stores no
   numeric grade.

## 2. Scope

**In:**
- Deep Linking for an **assignment** placement (build first) and a **course/topic** link placement
  (build second).
- A picker that **selects existing** trinket content (no inline creation).
- The **minimal AGS slice** required to make a submission reviewable in SpeedGrader: capture the
  line-item endpoint on launch, mint a service token, and POST one "submitted, pending manual grade"
  AGS Score (no numeric score) when a student submits.
- The SpeedGrader review launch, rendered by **reusing** trinket's existing
  `assignment-embed-feedback` view (instructor may *optionally* leave trinket qualitative feedback).

**Out (deferred):**
- **RCE / "embed in a page or quiz" placement** (`editor_button`) — a separate later increment.
- **Inline content creation** in the picker (create a new course/assignment from the LMS).
- **Real grade passback** (trinket computing/pushing a numeric score). trinket only *announces* the
  submission; the human enters the grade in the LMS.
- **NRPS** (roster sync), **LTI 1.1**.
- **mongo/redis implementations** of the new seams (Firestore only now; seams kept portable — §10).

## 3. Why B1 needs a slice of AGS (verified, not assumed)

We verified the Canvas behavior against **this testbed's actual Canvas source**
(`release/2026-05-20.99`, LTI 1.3) cross-checked with Canvas's official LTI docs. Result:

- **Launching the tool from an external-tool assignment creates NO submission.** The entire LTI
  launch path has no submission-creation call.
- **The only thing that makes student work appear in SpeedGrader is an AGS Score POST** carrying
  Canvas's submission extension `https://canvas.instructure.com/lti/submission` with
  `submission_type: "basic_lti_launch"` + `submission_data: <per-student URL>`
  (`app/controllers/lti/ims/scores_controller.rb:432-448`; matches Canvas's grading docs at
  developerdocs.instructure.com `.../score`). No score POST ⇒ SpeedGrader shows "No Submission".
- **The review is NOT a special message.** SpeedGrader re-launches the stored `submission_data` URL
  **as the instructor** — a plain resource-link `retrieve` launch, **no `for_user` / student-identity
  claim** (`app/views/submissions/show_preview.html.erb:337`,
  `app/presenters/submission/show_presenter.rb:74-84`). The teacher sees the right student's work
  only because the URL the tool itself supplied identifies that submission. (Canvas's `for_user` /
  "submission review" message exists only for the unrelated Asset Processor feature.)
- **Canvas auto-creates the line item** from the deep-linked assignment, so the tool never calls the
  Line Items service — it only needs the **score** scope.

Consequence: B1 unavoidably needs one new primitive — an OAuth client-credentials **service token** —
plus a single AGS Score POST. It does **not** need full grade passback: the POST sets
`activityProgress: Submitted`, `gradingProgress: PendingManual`, and **no `scoreGiven`**, so the grade
is still entered by the human in the LMS and never stored in trinket.

## 4. Architecture

### 4.1 Seam map (new vs. reused)

| Layer | New | Reused / extended |
|---|---|---|
| Controller (`lib/controllers/lti.js`) | deep-linking launch (renders picker); deep-linking select (builds/returns response); review-target branch in the launch handler | the launch handler + its `message_type` fork (currently `lti.js:212`) |
| Util seams (`lib/util/`) | `ltiDeepLinking.js`, `ltiServiceToken.js`, `ltiAgs.js` | `ltiKeys` (signs the DL response **and** the client-assertion), `ltiVerify`, `ltiProvision`, `ltiInstructorAuthority`, `ltiTarget` (extended: `review` target) |
| Models (`lib/models/`) | — | `ltiResourceLink.js` (extended: `agsLineItemUrl`), `ltiUserIdentity.js`, `ltiPlatform.js` (`authTokenUrl` already present) |
| View / grading | the picker view | `assignment-embed-feedback` view + `course.sendFeedback` endpoint |
| Registration | — | `ltiRegistration.js` (extended: DL message, placements, score scope) |

### 4.2 End-to-end flows

**Flow 1 — Instructor sets up the assignment (Deep Linking).**
1. In the LMS, the instructor adds trinket via the assignment's external-tool/"Find" → a
   `LtiDeepLinkingRequest` arrives at `/lti/launch` (same OIDC `/lti/login → /lti/launch` flow as v1).
2. trinket verifies it (`ltiVerify`), signs the instructor in (`ltiProvision` +
   `ltiInstructorAuthority`), reads the `deep_linking_settings` claim (`deep_link_return_url`, opaque
   `data`), and stashes `return_url` + `data` in the session.
3. trinket renders the **picker** (the instructor's courses → assignments, or courses → topics).
4. On selection, `ltiDeepLinking.js` builds a **Deep Linking Response JWT** (signed by `ltiKeys`,
   echoing `data`) with the content item, returned as an auto-submitting form POSTing to
   `deep_link_return_url`.
5. The LMS creates the external-tool assignment **and** its gradebook column (line item).

**Flow 2 — Student does & submits the work.**
1. Student clicks the assignment → normal resource-link launch → `ltiTarget` resolves the assignment
   target (custom param `trinket_assignment`), enrolls, lands them in the assignment trinket (v1 path).
2. On that launch, trinket **captures the AGS `endpoint` claim's `lineitem` URL** and stores it
   write-once on the assignment's `LtiResourceLink`.
3. Student works and submits in trinket (existing flow → `submissionState: submitted`).
4. On submit, `ltiAgs.js` POSTs **one Score** (auth via `ltiServiceToken`):
   `activityProgress: Submitted`, `gradingProgress: PendingManual`, **no `scoreGiven`**, plus the
   `https://canvas.instructure.com/lti/submission` extension (`new_submission: true`,
   `submission_type: "basic_lti_launch"`, `submission_data: <per-student review URL>`,
   `submitted_at`).

**Flow 3 — Instructor reviews in SpeedGrader.**
1. Instructor opens SpeedGrader → the LMS re-launches the stored review URL **as the instructor**
   (a plain resource-link launch; no special message, no `for_user`).
2. trinket's launch handler reads the review id from the **`target_link_uri` claim** (the LMS
   `retrieve` re-launch sets `target_link_uri` to the stored review URL — it does *not* attach custom
   params), loads the submission, **authorizes** the launcher via the existing
   `send-submission-feedback` permission on that submission's course, and renders
   `assignment-embed-feedback`.
3. Instructor reads the work and types the grade **in SpeedGrader** (stored in the LMS); may
   optionally leave trinket feedback via the existing `sendFeedback` endpoint.

## 5. Increment A — Deep Linking

- **Message fork:** at `lti.js:212`, add `LtiDeepLinkingRequest → deep-linking handler` (today it
  throws `Unsupported message_type` on anything but `LtiResourceLinkRequest`).
- **Picker:** a server-rendered trinket page inside the LMS iframe (iframe-safe via the existing
  `SameSite=None; Secure` cookie + per-route `xframeDeny` config). Lists the signed-in instructor's
  courses and drills into assignments (assignment placement) or topics (link placement). Reuses
  existing course/material listing queries. Empty state when the instructor has no content
  ("create one in trinket first"). **Select existing only** — no inline creation.
- **Content items:**
  - Assignment: `{ type: "ltiResourceLink", title, url: <assignment launch URL>,
    custom: { trinket_assignment: <materialId> }, lineItem: { scoreMaximum: 1, label } }`.
  - Course/topic: `{ type: "ltiResourceLink", title, url: <launch URL>,
    custom: { trinket_course: <id> } }` (or `trinket_topic`); **no** `lineItem`.
- **Target encoding = custom parameters** (decided), reusing `ltiTarget`'s existing
  `trinket_course` / `trinket_topic` / `trinket_assignment` resolution and its first-launch
  `LtiResourceLink` persistence (LTI-SPEC §6). No bespoke per-target routes.
- **Registration (`ltiRegistration.js`):** add `{ type: "LtiDeepLinkingRequest" }` plus the Canvas
  placements `assignment_selection` (assignment) and `link_selection` (course/topic).
- **Build order within A:** assignment placement first (exercises the `lineItem`, prerequisite for
  B1), then the course/topic link placement (same handler, simpler content item).

## 6. Increment B1 — submission notification + SpeedGrader review

- **Capture the line item (Flow 2.2):** read `…/lti-ags/claim/endpoint.lineitem` from the student
  launch and store it on the assignment's `LtiResourceLink.agsLineItemUrl` (write-once, folded into
  the existing first-launch write).
- **`ltiServiceToken.js`:** mint a `private_key_jwt` client-assertion (signed by `ltiKeys`, `aud` =
  `LtiPlatform.authTokenUrl`), exchange at the platform token endpoint for a bearer token with
  `grant_type=client_credentials&scope=https://purl.imsglobal.org/spec/lti-ags/scope/score`,
  **cache per-platform in memory** until expiry (refetch on expiry/`401`).
- **`ltiAgs.js`:** resolve the line item for a submission via `(courseId, materialId)` →
  `LtiResourceLink{targetType: assignment, targetId: materialId}.agsLineItemUrl`; POST the Score
  (Content-Type `application/vnd.ims.lis.v1.score+json`) to `<lineitem>/scores`. **Skip silently**
  when no line item was captured (course link, or non-LTI/standalone submission).
- **Review URL (`submission_data`):** a trinket URL carrying a **plain submission id**, e.g.
  `…/lti?review=<submissionTrinketId>` (it becomes the `target_link_uri` of the LMS `retrieve`
  re-launch, so trinket parses the id from the **`target_link_uri` claim**, not a request query).
  Authorized on resolve (decided): the LMS re-launches it as the instructor; trinket verifies the
  launch, loads the submission, and gates on the existing `send-submission-feedback` course
  permission (the real security boundary). No signed token.
- **Render:** reuse `assignment-embed-feedback`; trinket feedback is **optional** (via the existing
  `course.sendFeedback`). The numeric grade is always entered in the LMS.
- **Registration:** add the `…/lti-ags/scope/score` scope (this flips the existing test that asserts
  zero AGS scopes). Only the score scope is needed — the line-item URL comes from the launch claim
  and Canvas creates the line item from the deep link.

## 7. Data model

One new field; no new models or collections.

- **`LtiResourceLink.agsLineItemUrl: String`** — captured write-once from the launch endpoint claim.

Already present and reused: `LtiResourceLink{platformId, resourceLinkId, contextId, courseId,
targetType(course|topic|assignment), targetId}`; submission `Trinket{_owner, courseId, materialId,
submissionState}`; `LtiPlatform.authTokenUrl`; `LtiUserIdentity{iss, sub, userId}`.

**Line-item resolution at submit:** `(courseId, materialId) → LtiResourceLink(targetType=assignment,
targetId=materialId).agsLineItemUrl + platformId`. Post if found; skip otherwise.

## 8. Error handling

- **The AGS Score POST is best-effort and must never fail or block the student's submission.** The
  trinket submission is the source of truth; the LMS notification is a side effect. On failure: log;
  retry once after a token refresh on `401`; otherwise give up. (Limitation: a failed post means the
  submission won't surface in SpeedGrader until the student resubmits — see §12.)
- **Deep linking:** a non-instructor reaching a deep-linking launch is denied the picker (placing
  content is an instructor act). Missing `deep_link_return_url` → error. Empty picker → empty state.
- **AGS:** no line item captured → skip the POST silently.
- **Review launch:** `review` id missing/foreign, or launcher lacks `send-submission-feedback` on the
  course → deny. The launch still runs full `ltiVerify` (signature/nonce/state).

## 9. Firestore cost (per CLAUDE.md)

**No new per-launch writes.** `agsLineItemUrl` capture folds into the existing first-launch
`LtiResourceLink` write (later launches write only if absent). The service token is an in-memory
cache; the Score POST and the review launch are external HTTP / normal indexed reads. This
deliberately avoids repeating the per-launch-write regression from the instructor-authz work.

## 10. Portability (oss mongo/redis)

All three new seams are pure HTTP + crypto via `ltiKeys` — no Datastore coupling. The
`LtiResourceLink` field rides the existing model layer (Firestore and mongo). The token cache is
in-memory per instance (fine on gcr Cloud Run and oss; a redis-backed cache is a later option, not
needed for correctness). Same "plain fields + util functions behind a seam" pattern as
`ltiInstructorAuthority`. Firestore is the only backend built now (per LTI-SPEC §2/§10.1).

## 11. Testing

- **Unit:** DL response JWT (shape + echoed `data`; assignment vs course/topic content items);
  `ltiServiceToken` (client-assertion shape, cache, refetch on expiry/`401`); `ltiAgs` (Score body
  carries the submission extension and **no `scoreGiven`**; skip-when-no-lineitem); `ltiTarget`
  review resolution + authz; the `message_type` fork (DL → picker; review → render); registration now
  advertises the DL message + placements + score scope (updates the existing "no AGS" assertion).
- **Integration (mock platform; the in-container technique):** DL launch → picker → select →
  response POSTed to a captured `return_url` with the correct content item; student launch captures
  the line-item URL; submit fires a Score POST to a mock `/scores` with the right body; review launch
  renders the correct submission and denies the wrong user.
- **Manual (the local Canvas testbed):** deep-link an assignment → submit as a student → confirm it
  appears in SpeedGrader → review + grade end-to-end.

## 12. Open questions

1. **AGS durability:** v1 is best-effort + one `401` retry; a failed post means no SpeedGrader entry
   until the student resubmits. Durable retry/reconciliation (a queue or a relaunch-time backfill) is
   deferred. Acceptable for v1?
2. **Multi-placement:** one trinket assignment deep-linked into multiple LMS courses ⇒ multiple
   resource links / line items. v1 assumes **one LTI placement per `(course, assignment)`** and posts
   to that course's line item. Per-context resolution for the same assignment across courses is
   future work.
3. **`scoreMaximum` at deep-link time:** set a placeholder (`1`) and let the instructor set real
   points in the LMS, vs. omit and rely on the LMS default.

## 13. Build order (each milestone independently testable)

1. **Assignment Deep Linking** — message fork + `ltiDeepLinking` + picker + select + registration
   (DL message + `assignment_selection`). → instructor places a graded trinket assignment.
2. **B1 chain** — capture `agsLineItemUrl` on student launch → `ltiServiceToken` + `ltiAgs` Score POST
   on submit (+ score scope) → review-target resolution + render. → end-to-end SpeedGrader review.
3. **Course/topic links** — extend picker + content item (no line item) + `link_selection`.
   (Independent of B1; may move earlier.)
4. **Later, separate increment:** RCE / quiz-embed placement (`editor_button`).
