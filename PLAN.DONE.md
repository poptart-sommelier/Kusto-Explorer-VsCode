# Completed Work

This file is the historical record of notebook and result-session work that has shipped. Entries are
moved here from [PLAN.md](PLAN.md) once they are implemented and validated.

- **Upcoming work and open questions** live in [PLAN.md](PLAN.md).
- **Settled architecture and design decisions** live in [ARCHITECTURE.md](ARCHITECTURE.md).

Each entry records what was delivered and how it behaves, so that later work does not silently
contradict a decision that was already made and validated. Entries are append-only history: if
behavior later changes, add a new entry rather than rewriting an old one.

---

## Phase 1: Contracts and performance baseline

Implemented August 28, 2026 (`076495d`, `b822141`).

Delivered:

- The versioned `.kqlnb` notebook format.
- Result-session state, lifecycle, and typed RPC contracts.
- A synthetic mixed-type fixture of at least 100,000 rows.
- Measurements of the pre-existing query/result path for time, memory, serialized size, and UI
  responsiveness.
- Recorded service-aware generated-query size budgets.
- Notebook and result-session seams documented in `ARCHITECTURE.md`.

Met exit criteria:

- The protocol represents execution progress, paging, filtering, cancellation, and disposal.
- Baseline measurements are repeatable.
- No implementation requires putting a complete result into notebook output JSON.

The captured baseline and the benchmark commands are recorded in `ARCHITECTURE.md` under the
current-path performance baseline. The contracts were deliberately not wired to runtime handlers
until Phase 3 began.

---

## Phase 2: Native notebook shell

Implemented August 28, 2026 (`e76db77`).

Delivered:

- Registration of the `.kqlnb` notebook type.
- The notebook serializer and controller.
- KQL language services inside notebook cells.
- Reuse of the existing connection selection and query execution.
- Markdown cells, execution order, progress, errors, and cancellation.
- Serialization of cells and metadata without outputs.

Met exit criteria:

- A notebook can be created, saved, reopened, and rerun.
- KQL completion and diagnostics work in code cells.
- No access token or result row is written to the notebook file.

Until Phase 3 replaced whole-result transport, notebook queries and rendered previews used explicit
temporary safety limits.

---

## Phase 3: Scalable local result sessions

Implemented (`47021a4`) with server-owned, paged `DataTable` snapshots.

Delivered:

- Replacement of whole-result notebook transport with local result sessions.
- Materialization of query rows into the result-store abstraction.
- Paged result retrieval and deterministic disposal.
- The virtualized notebook grid.
- Typed display, scrolling, sorting, selection, copying, and column layout.

Met exit criteria:

- A 100,000-row mixed-type result can be browsed without a full copy in the renderer.
- Scrolling does not block the extension host.
- Cancelling or closing a notebook releases the result session and temporary storage.

Known limitation carried forward: Kusto.Data finishes parsing a server response before pages become
available, so true row-by-row arrival still requires a future streaming connection seam.

---

## Phase 4: Per-column regex filtering

Implemented (`43ee540`).

Delivered:

- A filter row with one regex input per column.
- The testable filter model and local server evaluator.
- Cancellation, invalid-pattern errors, timeouts, row counts, and progress.
- Filters preserved while scrolling and when changing column layout.
- Local filtering tests using the 100,000-row fixture.

Met exit criteria:

- Multiple column filters combine with `AND`.
- Filtering does not issue a new Azure query.
- Invalid or pathological regex input cannot freeze the extension or local server.
- The grid remains interactive while filters are replaced or cancelled.

Behavior: filters run against the retained local snapshot, default to case-insensitive matching, and
can be made case-sensitive per column. Invalid or timed-out patterns leave the previous ready view
available. Patterns are limited to 4,096 characters, each match has a 100 ms timeout, and a complete
evaluation is limited to five seconds.

---

## Phase 5: Snapshot continuation

Implemented (`923eff5`).

Delivered:

- Projection of selected or filtered rows from a result session.
- Generation of typed and correctly escaped `datatable()` KQL.
- Measurement of complete generated query size in UTF-8 bytes.
- Service-specific safety budgets.
- Compilation of supported local filters into KQL predicates.
- A confirmation and semantic warning before a live rerun.
- Generated cells clearly labeled as snapshot-based or rerun-based.

Met exit criteria:

- Small snapshots produce valid KQL that represents the exact selected values.
- Oversized snapshots never produce a query known to exceed the service limit.
- A live rerun cannot occur without explicit user confirmation.
- Unsupported regex translations are reported rather than silently changed.

Behavior: the result grid can create a new cell from a rectangular selection or the complete ready
filtered view. Exact snapshots remain local until the generated cell is run. Oversized filtered views
offer a capability-checked live rerun only after an explicit warning; oversized selections and unsafe
translations fail with a clear explanation.

---

## Phase 6: User-provided KQL enrichments

Implemented September 1, 2026. This replaced an earlier Phase 6 concept that generated built-in
include/exclude/summarize/join queries; that concept was abandoned rather than deferred.

Delivered:

- A `msKustoExplorer.notebook.enrichmentFolder` setting and a folder picker that writes it.
- Recursive discovery of `.kql` snippets, grouped by folder path relative to the library root.
- A snippet metadata header of `// @name`, `// @description`, and `// @prompt name:type label`
  comment directives, so a snippet stays a valid `.kql` file.
- A right-click request from the result grid carrying the selection and clicked-cell context.
- A searchable VS Code picker grouped by folder, with prompt collection either by typed entry or
  from a column of the clicked row.
- A server RPC that generates the whole cell from retained rows.
- Generated cells inserted below the source cell with `enrichment` continuation metadata recording
  the snippet id.

Met exit criteria:

- Right-clicking a result value exposes every discovered snippet under its containing folder.
- The generated `datatable()` contains all columns for each selected or right-clicked row exactly
  once.
- The snippet can read the clicked column and value, the selected column names, and declared prompt
  values through generated scalar variables.
- Generated KQL is visible and editable in the next cell and runs using the active Kusto connection.
- Oversized enrichments fail with a size error naming the budget, and malformed headers are reported
  rather than silently ignored.

Behavior: the enrichment input is the union of the selected rows and the right-clicked row, each
included once with all result columns. The generated cell declares `LocalResult`, `ClickedColumn`,
`ClickedValue`, and `SelectedColumns`, followed by prompt `let` statements and the snippet body. Those
four names are reserved, and a snippet declaring a prompt that shadows one is rejected before
insertion. Rows never cross into TypeScript: the C# server owns projection, escaping, and the whole
generated query, including its UTF-8 budget check.

Known limitation carried forward: the library is re-scanned when the picker opens rather than watched,
and prompt values entered manually for non-string types are emitted verbatim as KQL expressions, which
is safe because the generated cell is reviewed by the user and never executed automatically.

---

## Result-grid usability

Implemented (`3dbf092`).

Delivered:

- Scope-specific **Create cell from selection / filtered results / all results** labels, replacing the
  earlier **Continue results** wording that did not explain that a new cell is created.
- Removal of the low maximum column width.
- Manual drag resizing up to practical canvas and browser limits.
- Column auto-fit from the heading and the widest value in currently loaded pages, available by
  double-clicking a resize handle or pressing <kbd>Enter</kbd> on it.
- Keyboard resizing with arrow keys and ARIA width state on the resize separator.
- Preserved horizontal scrolling, virtualization, and in-session widths for very wide tables.

Met exit criteria:

- A user can widen a column enough to read long values without truncation imposed by the extension.
- Auto-fit produces a useful width for the values currently available without scanning or copying the
  complete result into the renderer.
- Renaming the action did not change exact-snapshot or live-rerun safety behavior.
