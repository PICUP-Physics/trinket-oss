# trinket-oss development notes

## Firestore read/write costs

This project uses Firestore as its database backend (configured via `db.backend: firestore`).
Firestore bills per document read and write, so be vigilant when writing or reviewing code that touches the database:

- Avoid fetching documents just to check a field — use targeted queries.
- Avoid N+1 patterns (e.g. loading a list, then fetching each item individually in a loop).
- Prefer batched reads (`$in` queries, `findByIds`) over sequential individual lookups.
- Cache or reuse documents already in scope rather than re-querying.
- Be especially careful in hot paths: embed views, trinket loads, course page loads.

The Firestore backend lives in `lib/db/firestore-backend.js`. The MongoDB backend is still present for local/legacy use.
