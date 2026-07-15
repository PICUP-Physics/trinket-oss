# Trinket LTI — FERPA & Data-Privacy Assessment

- **Status:** DRAFT for review — internal foundation document
- **Owner:** «CONFIRM: responsible person / role»
- **Last updated:** 2026-06-21
- **Scope:** Trinket acting as an **LTI 1.3 tool** that institutions connect to their LMS (Canvas, Moodle, D2L/Brightspace) so students and instructors launch into Trinket courses.

> **This is not legal advice.** It is an engineering/operational assessment to (a) inventory the
> student data Trinket actually processes, (b) frame Trinket's role under FERPA, and (c) drive the
> concrete artifacts an institution's InfoSec/privacy review will ask for. Have counsel review any
> Data Privacy Agreement before signing, and have your institution-side contact confirm their own
> FERPA interpretation — institutions vary.

---

## 1. Trinket's role under FERPA

FERPA governs **student education records** held by a school. A third-party tool like Trinket does
not become FERPA-regulated on its own; instead, the institution extends FERPA obligations to the
vendor through the **"school official" exception (34 CFR §99.31(a)(1))**, which requires that the
vendor:

1. performs an institutional service the school would otherwise use its own employees for;
2. is under the **direct control** of the institution with respect to the use and maintenance of
   education records;
3. uses the data **only for the authorized purpose** and does not re-disclose it.

**Trinket's intended posture:** Trinket is designated a *school official* providing the
"interactive coding coursework" service, under the institution's direct control, using launch data
solely to authenticate the user and place them in the correct Trinket course. This posture is what
a Data Privacy Agreement (§4) memorializes.

**Practical implication:** the institution stays the FERPA data controller; Trinket is the
processor acting on its behalf. The artifacts in §4 exist to evidence items (2) and (3).

---

## 2. Data inventory & flow  *(grounded in the LTI implementation)*

### 2.1 What Trinket receives at launch

Trinket's registered tool configuration requests exactly these identity claims
(`lib/util/ltiRegistration.js` → `buildToolConfiguration().claims`):

| Claim | Example | Classification |
| --- | --- | --- |
| `iss` (issuer) | `https://canvas.uindy.edu` | Institutional, not PII |
| `sub` (subject) | opaque per-platform user id | Pseudonymous identifier |
| `name`, `given_name`, `family_name` | "Jane Student" | Directory-information PII |
| `email` | `jstudent@uindy.edu` | Directory-information PII |
| `roles` (LMS role claim) | Instructor / Learner | Role, not PII |
| `deployment_id`, context/resource-link | course id + title | Course association |

Trinket does **not** request or receive: grades, date of birth, SSN/student ID numbers,
disability status, financial data, or any special-category data. (Trinket has **no AGS/grade
scopes** in v1 — see the LTI spec.)

### 2.2 What Trinket persists, and where

| Record | Fields stored | Source | Notes |
| --- | --- | --- | --- |
| `User` | email (or a synthesized `(iss,sub)` placeholder when the launch carries none), fullname, generated username, `isInstructor`, `source:'lti'`, `approved` | launch claims | `lib/util/ltiProvision.js` |
| `LtiUserIdentity` | `iss`, `sub`, `userId`, email, name | launch claims | the durable LMS-identity ↔ Trinket-user link |
| Course membership | role (`course-admin` \| `course-student`) on a Trinket course | launch + authority | per-course enrolment |
| `LtiPlatform` | issuer, client_id, key/endpoint URLs, status | registration | **institutional config, not student PII** |
| `LtiRegistrationToken` | sha256 token hash, label, initiating-instructor email, expiry | registration | **not student PII**; single-use, expiring |
| Session | cookie-based session (`SameSite=None; Secure`) | runtime | «CONFIRM: session store — cookie-first; any server-side spillover?» |

**Storage backend:** «CONFIRM: production backend» — current production target is **Google
Cloud Firestore** (GCP / Firebase). Hosting region: «CONFIRM: region, e.g. us-central1».

### 2.3 Sub-processors

| Sub-processor | Purpose | Data exposed |
| --- | --- | --- |
| Google Cloud Platform (Firestore, Cloud Run, Firebase Auth) | hosting, database, auth | all stored data above |
| «CONFIRM: email provider, if any (e.g. for invitations)» | transactional email | email addresses |
| «CONFIRM: any analytics / error monitoring / CDN» | — | — |

> Maintain this as the canonical sub-processor list — institutions ask for it directly and DPAs
> reference it.

### 2.4 Transmission security

- All LTI traffic is **HTTPS**; the launch is a **signed JWT** verified against the platform JWKS.
- **No PII is placed in URLs/query strings** — identity travels inside the signed `id_token`
  (an LTI Advantage property). Trinket's registration tokens are random + sha256-at-rest.
- Firestore: encrypted in transit and **at rest** by default (GCP-managed). «CONFIRM: CMEK vs
  Google-managed keys».

### 2.5 Retention & deletion

«CONFIRM: this is a policy decision Trinket must make and document» —

- How long are `User` / `LtiUserIdentity` / course-membership records kept after a course ends or a
  student leaves?
- Is there a deletion path on institutional request (delete all records for issuer X / a given
  `sub`)? **Recommended action:** define and document a deletion procedure (see §5).
- Backups: «CONFIRM: backup retention + whether deletions propagate to backups».

### 2.6 Access control

«CONFIRM» — Who at Trinket can view stored student data (admins via `/admin`, support, engineers
with DB access)? What authentication + audit covers that access? The unified site-admin role
(`hasRole("admin")`, see `docs/authority-model.md`) gates the in-app `/admin` area; document the
infrastructure-level access (GCP IAM) separately.

---

## 3. Data-minimization statement

Trinket collects the **minimum identity needed to authenticate a user and enrol them in the right
course**: name + email (directory information) and an opaque LMS subject id, plus the course
association and a coarse role. It collects no grades, no demographic/special-category data, and no
data beyond the launch. This minimization is itself a strong FERPA/privacy posture and should be
stated plainly to reviewers.

---

## 4. Compliance artifacts — what reviewers ask for, and our status

| Artifact | What it is | Status | Owner |
| --- | --- | --- | --- |
| **Data Privacy Agreement (DPA)** | The contract designating Trinket a "school official" under direct control; the operative FERPA instrument. Many US schools use the SDPC **NDPA** (National Data Privacy Agreement) so you sign one base + per-state exhibit. | «CONFIRM: none yet» | legal |
| **HECVAT** (Higher Education Community Vendor Assessment Toolkit) | Standardized security questionnaire. **HECVAT-Lite** is usually enough for a low-data-volume tool like this; Full if a school insists. | Need (pre-stage answers) | security |
| **VPAT / accessibility statement** | Accessibility conformance (Section 508 / WCAG). Often bundled into the same review. | «CONFIRM» | product |
| **Public Privacy Policy** | A privacy policy covering student data, retention, sub-processors, contact. | «CONFIRM: exists at trinket.io?» | legal |
| **Sub-processor list** | §2.3 above, kept current and publishable. | Draft here | ops |
| **Data-deletion procedure** | Documented process to delete a student's / an institution's data on request. | Need (see §5) | engineering |
| **Incident-response plan** | Breach notification process + timeline. | «CONFIRM» | security |
| **1EdTech Data Privacy / TrustEd Apps certification** *(optional)* | The 1EdTech *privacy* credential (distinct from LTI Advantage interop cert). Eases some reviews; not required. | Optional / later | — |

> **Reminder (recorded separately):** 1EdTech **LTI Advantage Certification** is protocol
> conformance — it does **not** address FERPA. The privacy-relevant 1EdTech program is
> **Data Privacy / TrustEd Apps**. Pursue LTI Advantage cert for interoperability credibility, not
> to clear FERPA.

---

## 5. Gap analysis & action checklist

Ordered by what unblocks an institutional review soonest:

- [ ] **Decide & document a data-retention + deletion policy** (§2.5). This is the most common
      hard question and Trinket controls it entirely. Define: retention horizon, deletion-on-request
      path (by `issuer`, by `sub`, by user), backup propagation.
- [ ] **Implement a deletion procedure** matching the policy (a script/endpoint to purge a
      student's `User` + `LtiUserIdentity` + memberships, and an institution-wide purge by issuer).
- [ ] **Finalize the sub-processor list** (§2.3) — confirm email/analytics/monitoring providers.
- [ ] **Pre-stage HECVAT-Lite answers** from §2 so each institution's questionnaire is a fill-in,
      not a from-scratch effort.
- [ ] **Confirm/publish a public Privacy Policy** that names student data, retention, sub-processors,
      and a privacy contact.
- [ ] **Draft a standard DPA position** — decide whether to adopt the **SDPC NDPA** as your base
      agreement (recommended: it's what many schools already use, minimizing per-school negotiation).
- [ ] **Produce/locate a VPAT** (or an accessibility conformance statement).
- [ ] **Write an incident-response one-pager** (who's notified, within what window).
- [ ] Confirm GCP region + encryption-key posture (§2.4) for the security questionnaire.
- [ ] (Optional, later) evaluate **1EdTech Data Privacy / TrustEd Apps** certification once several
      institutions are onboard.

---

## 6. Institution-review playbook (what to expect)

When an institution's LMS/InfoSec team evaluates Trinket they will typically, in roughly this order:

1. Ask **what data** the tool receives → answer from §2 (the data-minimization story is your friend).
2. Send a **HECVAT** (usually Lite) → answer from pre-staged §2 facts.
3. Require a **DPA** → offer your standard NDPA position (§4).
4. Possibly ask for a **VPAT** and your **Privacy Policy**.
5. For a **sandbox/test** registration, most of this is **waived or lightweight** — which is why the
   first D2L/Brightspace validation should happen in a test org unit, not production.

A small, self-hosted, faculty-driven, minimal-data tool is on the *easy* end of this spectrum. The
work is mostly about having the §4 artifacts ready so each review is a hand-off, not a project.
