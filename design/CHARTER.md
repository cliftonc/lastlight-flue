# Design workstream — charter

This folder holds the **high-level design** for rebuilding Last Light on Flue,
produced **phase by phase, sequentially**, by a background agent. It sits one
level below `spec/` (which says *what must be true*); design says *how we'll
build it on current Flue*.

## Inputs (read these)
- `spec/README.md`, `spec/00-overview.md`, `spec/flue-reference.md`, and the
  per-layer pages `spec/01..11`.
- `spec/IMPLEMENTATION-PLAN.md` — the canonical phase list (0–8).
- The reference implementation at `~/work/lastlight/` (source of truth for
  behavior) and its `spec/`.
- **Current Flue** — re-verify every capability against the live framework
  (it's beta, v1.0.0-beta.x, and moves fast). Prefer reading the repo
  `withastro/flue` via `gh api` (reliable) and the markdown docs at
  `https://flueframework.com/docs/<path>/index.md`. Pin versions and cite
  sources.

## Outputs
- `design/phase-0-spike.md` … `design/phase-8-cutover.md` — one design doc per
  phase (names follow `IMPLEMENTATION-PLAN.md`).
- `design/overall-architecture.md` — a **living** document. After each phase,
  fold that phase's cross-cutting concerns into the relevant section and append
  a dated changelog entry. Later phases build on what earlier phases recorded.

## Per-phase procedure (repeat for phase N = 0..8, in order)
1. **Re-research** the Flue capabilities this phase depends on, against the
   current framework. Note anything changed since `spec/flue-reference.md`; if
   a pinned signature drifted, record the correction.
2. **Write `design/phase-N-*.md`** using the design page contract below.
3. **Update `design/overall-architecture.md`** — merge this phase's
   cross-cutting concerns (runtime, sandbox/egress, persistence/durability,
   auth/security, API/compat surface, observability, config, testing, deploy)
   into the standing sections; add a changelog line. Do **not** duplicate the
   per-phase design here — only the cross-cutting, system-wide decisions.
4. **Commit progress by writing files** before moving to the next phase, so the
   run is resumable.

## Design page contract (every `phase-N-*.md`)
1. **Scope** — what this phase delivers (1–2 lines, from the plan).
2. **Current Flue research** — verified capabilities + API signatures this phase
   uses, each cited (doc URL or `withastro/flue` path) and version-pinned;
   deltas vs `spec/flue-reference.md`.
3. **Design** — concrete approach: module/file layout in `lastlight-flue/src`,
   key interfaces/types, data flow, and the Flue primitives wired together.
   Show small code sketches where they clarify the shape.
4. **Cross-cutting concerns raised** — what this phase contributes to
   `overall-architecture.md` (bullet list; mirror into that doc).
5. **Open questions / risks** — unknowns to resolve before/while implementing;
   link to the relevant `spec/` risk-register item where applicable.
6. **Acceptance hooks** — how the eventual implementation proves this design
   (tie back to the spec page's Acceptance criteria).

## Rules
- **Sequential only.** Finish phase N (all four steps) before starting N+1.
- **Design, not code.** Produce documents; do not build the application.
- **Honor the spec's locked decisions and invariants.** If research forces a
  deviation, record it in the phase doc *and* in `overall-architecture.md`'s
  risk/decision log — don't silently diverge.
- **The two load-bearing gaps** (Flue workflows aren't resumable → durability in
  sessions; Flue has no built-in egress firewall) must be carried through every
  phase they touch (esp. 0, 4, 6, 7, 8 and 0, 9-related work).
