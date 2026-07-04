# Trinket — Privacy & Data Handling Brief (for institutions)

*A one-page summary for LMS administrators and InfoSec/privacy reviewers evaluating Trinket as an
LTI 1.3 tool. For the full assessment see the maintainers; for a signed agreement see "Data Privacy
Agreement" below.*

- **Product:** Trinket — in-browser interactive coding coursework, connected to your LMS via LTI 1.3.
- **Vendor / contact:** «CONFIRM: legal entity, privacy contact email».
- **Hosting:** Google Cloud Platform (Firestore database, Cloud Run, Firebase Auth), region
  «CONFIRM».

## What data Trinket receives from your LMS

Only the identity needed to sign a user in and place them in the right course, delivered inside the
**signed LTI launch token** (never in a URL):

- Name (given/family/full) and email address — *directory information*
- An opaque per-platform user identifier (`sub`) and your issuer (`iss`)
- The user's course role (instructor vs. learner) and the course/link being launched

**Trinket does not receive or request:** grades, date of birth, government/student ID numbers,
disability or demographic data, financial data, or any data beyond the launch. Trinket requests
**no grade-passback (AGS) scopes** in this version.

## What Trinket stores

- A Trinket user account (name, email or a synthesized placeholder, a generated username, role).
- A link between the LMS identity (`iss`,`sub`) and the Trinket account.
- The user's membership and role in the corresponding Trinket course.

That's the whole footprint — no coursework content carries additional personal data beyond what the
student creates.

## Security

- All traffic is HTTPS; the launch is a cryptographically **signed JWT** verified against your
  platform's public keys (JWKS). No personal data is placed in URLs.
- Data is encrypted **in transit and at rest** (Google-managed encryption on Firestore).
- Access to stored data is limited to «CONFIRM: roles — e.g. Trinket administrators and authorized
  engineering staff under GCP IAM».

## Retention & deletion

- «CONFIRM: retention horizon».
- Trinket will delete a user's data, or all data associated with your institution (`issuer`), on
  written request — «CONFIRM: process + turnaround».

## Documents available on request

- **Data Privacy Agreement** — Trinket can execute a DPA designating it a *school official* under
  your direct control (FERPA §99.31(a)(1)); we can work from the **SDPC NDPA** if you use it.
- **HECVAT** (Lite) — completed security questionnaire.
- **VPAT / accessibility statement** — «CONFIRM».
- **Sub-processor list** and **public Privacy Policy** — «CONFIRM links».

## Getting started (low-friction path)

For evaluation, register Trinket in a **sandbox / test course** first — this typically needs no
formal review. Trinket connects via **LTI Dynamic Registration** (you paste a one-time registration
link an approved Trinket instructor generates) or via manual LTI Advantage registration if your LMS
prefers. Production access for real students is where the DPA/HECVAT above come in.
