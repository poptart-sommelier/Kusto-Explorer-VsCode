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

1. Run user-provided KQL enrichments against selected result rows from a right-click workflow.
2. Harden the notebook experience against real clusters, large results, and failure cases.
3. As a stretch goal, allow Python cells to analyze KQL results as pandas DataFrames.

Goals that are already met are listed in [PLAN.DONE.md](PLAN.DONE.md).

---

## Phase 6: User-provided KQL enrichments

**Status: next to be implemented.** Redesigned September 1, 2026. This definition replaces an earlier
Phase 6 concept that generated built-in include/exclude/summarize/join queries; that concept is
abandoned, not deferred.

### Agreed product decisions

- The user configures a folder on disk as the enrichment library.
- That folder may contain zero or more grouping folders, each containing `.kql` snippet files.
- The right-click picker groups snippets by containing folder and displays each `.kql` filename.
- Enrichments are user-provided KQL, not a fixed set of built-in query-rewriting actions.
- Running an enrichment creates visible, editable KQL in the next notebook cell and uses the
  notebook's active Kusto connection.

### Workflow

1. The user selects values from one or more rows and right-clicks a result value.
2. The enrichment input is the union of every currently selected row and the row containing the
   right-clicked value. Each row is included once, with all of its result columns.
3. VS Code shows the configured enrichment snippets, grouped by containing folder and named by
   `.kql` filename.
4. The user chooses a snippet and supplies any inputs declared by its metadata header.
5. The extension inserts a new KQL cell immediately below the source cell. The generated cell
   contains, in order:
   - A typed `datatable()` containing the complete enrichment input rows.
   - Scalar variables describing the right-clicked column and value.
   - A scalar representation of the selected column names.
   - Any scalar values collected from the snippet's declared prompts.
   - The selected `.kql` snippet.
6. The generated cell is visible and editable, and is not executed automatically.

Each snippet may contain a small metadata header declaring named run-time prompts. A prompt can be
answered manually or from a selected result column, including datetime values. The first version does
not restrict prompt sources or attempt to prove that a chosen column is compatible with the snippet;
invalid choices are allowed to fail with the normal Kusto error.

The selected rows are embedded in KQL and run against the active live Kusto service; there is no local
KQL execution engine. Existing typed literal escaping, UTF-8 query-text budgets, privacy warnings, and
credential rules apply. If the generated query is too large, the enrichment must stop with a clear
error rather than silently rerunning different source data.

### Deliverables

- A setting and folder picker for the enrichment-library location.
- Discovery of grouping folders and their `.kql` snippet files.
- Reading and validation of the snippet metadata header and declared prompts.
- A result-cell right-click request carrying the current selection and clicked-cell context.
- A VS Code enrichment picker grouped by folder and named by `.kql` filename.
- Projection of the union of selected rows and the right-clicked row, including every result column.
- Collection of declared inputs manually or from a selected column, without source-type restrictions.
- Generation of the next KQL cell with a typed `datatable()`, context scalar variables, prompt values,
  and the chosen snippet.
- Reuse of existing Kusto identifier/literal escaping, query-size budgets, warnings, and queued
  notebook insertion.

### Exit criteria

- Right-clicking a result value exposes every discovered snippet under its containing folder.
- The generated `datatable()` contains all columns for each selected or right-clicked row exactly
  once.
- The snippet can access the clicked column/value, selected column names, and declared prompt values
  through generated scalar variables.
- Generated KQL is visible and editable in the next cell and runs using the active Kusto connection.
- Oversized or malformed enrichments fail clearly without silently changing the selected data.

### Open questions for Phase 6

These must be answered before or during implementation:

- What exactly does the snippet metadata header look like, and how is it separated from runnable KQL?
- What are the generated scalar variable names, and how are collisions with snippet-defined names
  avoided?
- How deep may the enrichment library nest, and how are folders below the first level presented?
- What is shown when no enrichment folder is configured, or the folder contains no `.kql` files?
- Should a discovered snippet list refresh while VS Code is running, or only at startup?

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
- **TypeScript unit tests** — enrichment folder discovery, metadata parsing, prompt binding, picker
  grouping, generated KQL composition, and renderer right-click message validation.
- **Integration tests** — enrichment insertion into a live notebook, ordinary ADX and scoped Azure
  Monitor connections, closing and rerunning cells while operations are active, and regression
  coverage for existing `.kql` and `.kqr` behavior.

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
