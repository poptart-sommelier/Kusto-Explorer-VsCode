# Working Agreements

This file explains how planning and design documentation is organized in this repository, and the
rules that both humans and AI agents must follow when changing it.

For coding conventions and architectural rules, read [ARCHITECTURE.md](ARCHITECTURE.md) first. For
build, debug, and packaging steps see [CONTRIBUTING.md](CONTRIBUTING.md); for test commands see
[TESTING.md](TESTING.md).

---

## The three planning documents

Each document answers exactly one question. Do not blur them.

| File | Answers | Contains |
|---|---|---|
| [PLAN.md](PLAN.md) | What are we going to do next, and what is still undecided? | Upcoming phases, agreed-but-unbuilt product decisions, and open questions |
| [PLAN.DONE.md](PLAN.DONE.md) | What has already shipped? | Completed phases, what each delivered, and the exit criteria they met |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How is the product built, and why? | Settled architecture, component seams, contracts, invariants, and conventions |

### PLAN.md

- Contains **only** work that has not shipped and decisions that are not settled.
- Every phase carries an explicit status, such as *next to be implemented*, *not started*, or
  *paused*.
- Open questions are written as questions, under the phase they block.
- Remove an item as soon as it ships. `PLAN.md` is not a history file.

### PLAN.DONE.md

- Receives an entry when work is implemented **and** validated.
- Records what was delivered, the exit criteria that were met, resulting behavior, and any limitation
  knowingly carried forward.
- Is append-only history. If behavior later changes, add a new entry instead of rewriting an old one.

### ARCHITECTURE.md

- Records decisions that are settled and expected to remain true: process boundaries, ownership,
  seams, protocols, invariants, and conventions.
- Describes how the system *is*, not the sequence of work that produced it.
- Must be updated in the same change that alters a component, seam, or convention it describes.

---

## Moving work between the documents

When a phase is finished and validated:

1. Move its entry from `PLAN.md` into `PLAN.DONE.md`, keeping its deliverables and exit criteria and
   adding the resulting behavior.
2. Record any lasting design decision in `ARCHITECTURE.md`.
3. Delete the entry from `PLAN.md`, including any open questions the work answered.

When a decision is made but not yet built, it stays in `PLAN.md` under its phase. It only moves to
`ARCHITECTURE.md` once the implementation exists, so `ARCHITECTURE.md` never describes code that is
not there.

When a plan is abandoned rather than delivered, delete it from `PLAN.md` and say so in the replacement
entry. Do not move abandoned designs into `PLAN.DONE.md`.

---

## Rules for agents

- Read `ARCHITECTURE.md` before making structural changes, and keep it in sync with the change.
- Do not add planning notes, status files, or scratch markdown outside these three documents.
- Do not restate the same decision in more than one document; link between them instead.
- Do not record a phase as complete until its build, lint, type-check, and tests actually pass.
- Prefer editing an existing entry over adding a near-duplicate one.
- Keep entries short and factual. These files are read to make decisions, not to advertise progress.
