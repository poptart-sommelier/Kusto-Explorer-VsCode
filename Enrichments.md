# Right-click KQL enrichments

Right-click enrichments turn one or more rows from a Kusto notebook result into the input for a
reusable KQL snippet. The extension creates a new, editable KQL cell below the source cell; it never
runs the generated cell automatically.

Enrichments are available in result grids in `.kqlnb` notebooks. They are not currently offered in
the standard `.kql` Results panel or in `.kqr` result viewers.

## Configure an enrichment library

An enrichment library is a folder containing `.kql` files. Configure it in either of these ways:

1. Run a KQL cell in a notebook and right-click a result value.
2. When prompted, select **Select Folder...** and choose the library folder.
3. Right-click the result value again to open the enrichment picker.

Alternatively, set **Kusto Explorer > Notebooks: Enrichment Folder** in VS Code Settings, or add the
following global setting to `settings.json`:

```json
{
  "msKustoExplorer.notebook.enrichmentFolder": "C:\\Kusto\\Enrichments"
}
```

Subfolders group related enrichments in the picker. For example:

```text
Enrichments/
|-- summarize.kql
|-- devices/
|   |-- recent-events.kql
|   `-- owner.kql
`-- identities/
    `-- sign-ins.kql
```

The library is scanned whenever the picker opens, so saving a new or modified `.kql` file is enough
to make it available on the next invocation. The scan is limited to five directory levels and skips
dot-prefixed folders such as `.git`. Files that cannot be read are skipped without preventing other
enrichments from loading.

## Create an enrichment

Every `.kql` file in the configured folder is an enrichment. The smallest valid enrichment is an
ordinary KQL query that uses the generated `LocalResult` table:

```kusto
LocalResult
| summarize Rows = count()
```

Add comment directives near the beginning of the file to control how it appears and to request
inputs from the user:

```kusto
// @name Recent events for selected devices
// @description Finds recent events for the devices represented by the selected result rows.
// @prompt lookback:timespan Lookback window
// @prompt eventType:string Event type

let Devices =
    LocalResult
    | where isnotempty(DeviceId)
    | distinct DeviceId;
DeviceEvents
| where Timestamp >= ago(lookback)
| where DeviceId in (Devices)
| where EventType == eventType
| order by Timestamp desc
```

This example assumes that the source result and `DeviceEvents` both contain a `DeviceId` column.
When the enrichment is selected, enter a KQL timespan such as `7d` for `lookback` and a string such
as `Error` for `eventType`.

### Header directives

| Directive | Purpose |
|---|---|
| `// @name <text>` | Display name in the picker. Defaults to the filename without `.kql`. |
| `// @description <text>` | Searchable detail shown in the picker. |
| `// @prompt <name>:<type> <label>` | Declares a value that the user supplies before the cell is generated. The label is optional and defaults to the prompt name. |

Directives may be mixed with blank lines and ordinary leading comments, but they must appear before
the first KQL statement. Directive lines are removed from the generated cell; ordinary comments are
preserved. An `@` comment after KQL has started is treated as part of the query, not as a directive.
Unknown directives are ignored for forward compatibility.

Prompt names must begin with a letter or underscore and contain only letters, digits, and
underscores. A name can be declared only once and cannot be one of the generated reserved names:

- `LocalResult`
- `ClickedColumn`
- `ClickedValue`
- `SelectedColumns`

Supported prompt types are `bool`, `datetime`, `decimal`, `dynamic`, `guid`, `int`, `long`, `real`,
`string`, and `timespan`. Type names are case-insensitive, although lowercase is recommended.

Malformed directives, unsupported prompt types, duplicate or reserved prompt names, and snippets
with no KQL are reported in the picker as invalid. An invalid enrichment remains visible so that its
error can be diagnosed, but it cannot be run.

## Generated query context

The extension adds the following declarations before the snippet body:

| Name | Value |
|---|---|
| `LocalResult` | A typed `datatable()` containing the enrichment input rows and every result column. |
| `ClickedColumn` | The name of the right-clicked column as a KQL string. |
| `ClickedValue` | The right-clicked value, emitted using its actual Kusto type. |
| `SelectedColumns` | A dynamic array containing the names of the selected columns. If there is no prior selection, it contains the right-clicked column. |
| Prompt name | A scalar `let` value collected for each `@prompt` directive. |

For example, the generated cell has this general shape:

```kusto
// Enrichment over retained query results; embedded values run against live data.
let LocalResult = datatable (DeviceId: string, Severity: int) [
    "device-01", 3,
    "device-02", 2
];
let ClickedColumn = "DeviceId";
let ClickedValue = "device-01";
let SelectedColumns = dynamic(["DeviceId"]);
let lookback = 7d;

// The selected snippet body follows here.
LocalResult
| summarize Rows = count()
```

The exact string literal syntax is generated and escaped by the extension; the example is
illustrative.

### Which rows and columns are included

- With no existing selection, `LocalResult` contains the right-clicked row.
- With an existing rectangular selection, it contains all selected rows plus the right-clicked row.
- If the right-clicked row is already selected, it is included only once.
- `LocalResult` always contains every result column, not only the selected columns.
- `SelectedColumns` records the selected column range so the snippet can choose how to interpret it.
- Filtering and sorting are respected because row positions come from the current ready result view.

Click a cell to start a selection. Use Shift-click or Shift+Arrow keys to extend it before
right-clicking the value that should provide `ClickedColumn` and `ClickedValue`.

## Supply prompt values

For each `@prompt`, the picker offers two sources:

- **Enter a value**: `string` input is quoted and escaped automatically. Every other type is inserted
  as a KQL expression, so enter syntax such as `true`, `7d`, `datetime(2026-09-01)`,
  `ago(1h)`, or `dynamic(["a", "b"])` as appropriate.
- **Use a column from the clicked row**: choose a result column and the extension emits that column's
  value using its actual Kusto type. The declared prompt type does not cast a column-bound value; use
  `tostring()`, `tolong()`, or another explicit conversion in the snippet when needed.

Manually entered non-string values are KQL expressions rather than untrusted data. Review the
generated cell carefully if their source is not trusted.

## Run an enrichment

1. Run the source KQL cell and wait for its result grid to be ready.
2. Optionally select a rectangular range of cells.
3. Right-click the result value that should be the clicked-cell context.
4. Select an enrichment in the **Run Kusto Enrichment** picker.
5. Supply any declared prompts.
6. Review the generated KQL cell inserted immediately below the source cell.
7. Run the new cell when ready. It uses the notebook's active Kusto connection.

Changing an enrichment file affects cells generated after the change. It does not rewrite cells
that already exist in a notebook.

## Data handling and limits

Input rows are embedded directly in the generated cell as a typed `datatable()` snapshot. This has
several consequences:

- The embedded values are visible and editable in the notebook and are saved if the notebook is
  saved.
- Running the cell can place those values in service query logs.
- Any external tables queried by the snippet are read live when the generated cell is executed.
- The extension warns before creating a cell containing at least 1,000 rows or 48 KiB of query text.
- The complete generated cell must fit the service-specific UTF-8 safety budget: 60 KiB for scoped
  Azure Monitor, Log Analytics, Application Insights, and unrecognized endpoints; 900 KiB for a
  recognized native ADX endpoint.

If the query exceeds its budget, select fewer rows and invoke the enrichment again. The extension
does not silently drop rows, upload data, or execute a fallback query.

## Modify and troubleshoot enrichments

- **A saved change is not shown:** close or cancel the current picker, save the `.kql` file, and
  right-click a result again. The folder is rescanned when a new picker opens; it is not watched while
  the picker remains open.
- **A file is missing from the picker:** confirm that it has a `.kql` extension, is under the
  configured folder within the scan-depth limit, and is not inside a dot-prefixed or unreadable
  folder.
- **The picker reports an invalid header:** check the exact `@prompt name:type label` form, supported
  types, duplicate names, and reserved names. Make sure the file also contains a KQL body.
- **A directive appears in the generated query:** move it above the first KQL statement. Only the
  leading comment header is parsed for directives.
- **A prompt has an unexpected type:** column-bound prompts retain the selected result column's type.
  Add an explicit KQL conversion in the snippet.
- **The result session no longer exists:** rerun the source notebook cell, then invoke the enrichment
  from its new result grid.
- **The query is too large:** reduce the selected row count or simplify the snippet. All requested
  rows are kept or the operation fails; enrichments are never silently truncated.
