import { sqlite } from '@flue/runtime/node';

// Phase 0 · Spike 3 — durability adapter.
// File-backed SQLite makes Flue agent sessions + submission/run records survive a
// process restart on this host (without it, the Node target keeps everything in
// in-memory SQLite and loses it on exit). This is HALF of Last Light's durability;
// the other half is the application-owned run record in `run-store.ts`, which
// drives the workflow-level approval gate (Flue workflows are NOT resumable).
//
// Verified: `sqlite(path?)` from `@flue/runtime/node` (spec/flue-reference §0).
export default sqlite('./data/flue.db');
