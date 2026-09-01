# Plan: Upcoming Work

This file tracks **work that has not shipped yet** and **decisions that are still open**, for the
investigative notebook and scalable result experience in Kusto Explorer for VS Code.

- **Completed work** is recorded in [PLAN.DONE.md](PLAN.DONE.md).
- **Settled architecture and design decisions** are recorded in [ARCHITECTURE.md](ARCHITECTURE.md).

When a phase below is implemented and validated, move its entry into `PLAN.DONE.md` and record any
lasting design decisions in `ARCHITECTURE.md`. See [AGENTS.md](AGENTS.md) for the rules that keep
these three documents distinct.

The notebook workflow is additive. Existing `.kql` editors and `.kqr` result viewers remain supported
while it is built and evaluated.

---

## Remaining goals

1. Harden the notebook experience against real clusters, large results, and failure cases.
2. As a stretch goal, allow Python cells to analyze KQL results as pandas DataFrames.

Goals that are already met are listed in [PLAN.DONE.md](PLAN.DONE.md).

---

## Phase 7: Hardening and release

**Status: not started.**

Deliverables:

- Accessibility and keyboard-navigation review.
- Large-result and cancellation integration tests.
- Session cleanup, crash recovery, and stale-message tests.
- Real ADX and scoped Log Analytics smoke tests.
- User documentation for notebooks, filtering, continuation semantics, enrichments, and privacy
  warnings.
- Telemetry limited to non-sensitive performance and failure information, following repository
  policy.

Exit criteria:

- Existing `.kql` and `.kqr` tests continue to pass.
- Notebook behavior is reliable for the target dataset.
- Temporary result data is removed after disposal.
- Documentation clearly distinguishes local snapshots from live reruns.

---

## Stretch goal: Python and pandas interoperability

**Status: design incomplete, paused by request.** Do not start implementation until the open questions
below are answered.

The notebook should eventually support KQL, Python, and Markdown cells, with the language/runtime
shown clearly on every code cell.

Proposed behavior:

- A KQL result, filtered view, or rectangular selection can be made available to a Python cell as a
  typed pandas DataFrame.
- The generated Python cell names its input DataFrame explicitly and remains visible and editable.
- Python-generated DataFrames can be used by later Python cells.
- Moving Python DataFrame values back into KQL follows the same typed `datatable()`, UTF-8 budget,
  privacy warning, and live-rerun rules as other result continuations.
- Large transfers use an explicitly measured row/byte budget and a benchmarked typed transport; do
  not copy an unbounded result through notebook output JSON.
- Cancelling a cell, closing the notebook, or restarting its kernel releases associated transfer and
  result-session state.

### Open questions for Python support

- Which runtime executes Python: the user's selected VS Code Jupyter kernel, or a Python process
  managed by this extension? VS Code assigns one execution controller per notebook, so a `.kqlnb`
  notebook cannot select a Kusto controller and a Jupyter kernel through the standard kernel picker.
  The Jupyter extension's public API can execute code against a kernel that is already running for an
  open notebook, which constrains how a Jupyter-backed design would have to work.
- If the extension manages the runtime, what is its lifetime, and does state persist between cells?
- How are Python environments and required packages discovered and reported when missing?
- How are DataFrame outputs displayed, and do they reuse the Kusto result grid so that selections can
  feed further work?
- What are the memory, cancellation, and trust boundaries for executing user Python?

This work also requires DataFrame type mapping before an implementation phase is committed.

---

## Testing expectations for upcoming work

New work is expected to extend existing coverage rather than replace it. See [TESTING.md](TESTING.md)
for how to run each suite.

- **C# server tests** — enrichment row-union projection, typed `datatable()` composition, and UTF-8
  query-size enforcement for enrichment output.
- **TypeScript unit tests** — renderer message validation for new surfaces, and coverage for any new
  testable data model.
- **Integration tests** — ordinary ADX and scoped Azure Monitor connections, closing and rerunning
  cells while operations are active, and regression coverage for existing `.kql` and `.kqr` behavior.

---

## Explicitly deferred work

The first release will not include:

- Persisted notebook outputs.
- Automatic upload to Azure Blob Storage.
- Ingestion into Log Analytics custom tables.
- Transparent batching of many follow-on Azure queries.
- Collaborative notebook execution.
- A webview framework migration.
- Bundled security-specific IP, user, or host enrichment packs.
- Bundled JSON, URL, or regex-group parsing enrichment packs.
- Arrow transport unless JSON page measurements show that it is necessary.
- A command that converts an existing `.kql` document into notebook cells.

---

## References

- [VS Code Notebook API](https://code.visualstudio.com/api/extension-guides/notebook)
- [VS Code notebook output renderer API](https://code.visualstudio.com/api/extension-guides/notebook#notebook-renderer)
- [Kusto query limits](https://learn.microsoft.com/kusto/concepts/query-limits)
- [Azure Monitor service limits](https://learn.microsoft.com/azure/azure-monitor/fundamentals/service-limits)
- [Kusto `datatable` operator](https://learn.microsoft.com/kusto/query/datatable-operator)
- [Kusto string operators](https://learn.microsoft.com/kusto/query/datatypes-string-operators)
- [Kusto query best practices](https://learn.microsoft.com/kusto/query/best-practices)
