// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Runtime.Serialization;
using LSP = Microsoft.VisualStudio.LanguageServer.Protocol;

namespace Kusto.Vscode;

public static class ResultSessionProtocol
{
    public const int Version = 1;
    public const int MaxPageSize = 1_000;
    public const int MaxProjectionPageSize = 1_000;
    public const int ScopedQueryTextBudgetBytes = 60 * 1_024;
    public const int NativeAdxQueryTextBudgetBytes = 900 * 1_024;
    public const string StartMethod = "kusto/startResultSession";
    public const string CancelMethod = "kusto/cancelResultSessionOperation";
    public const string StatusMethod = "kusto/getResultSessionStatus";
    public const string SetViewMethod = "kusto/setResultSessionView";
    public const string PageMethod = "kusto/getResultSessionPage";
    public const string ProjectionMethod = "kusto/getResultSessionProjection";
    public const string ContinuationMethod = "kusto/createResultSessionContinuation";
    public const string EnrichmentMethod = "kusto/createResultSessionEnrichment";
    public const string DisposeMethod = "kusto/disposeResultSession";
}

public static class ResultSessionContractValues
{
    public const string StateQueued = "queued";
    public const string StateRunning = "running";
    public const string StateMaterializing = "materializing";
    public const string StateCompleted = "completed";
    public const string StateCancelled = "cancelled";
    public const string StateFailed = "failed";
    public const string StateDisposed = "disposed";

    public const string ViewStateNone = "none";
    public const string ViewStateEvaluating = "evaluating";
    public const string ViewStateReady = "ready";
    public const string ViewStateFailed = "failed";

    public const string FilterStateValid = "valid";
    public const string FilterStateInvalid = "invalid";

    public const string SortAscending = "ascending";
    public const string SortDescending = "descending";

    public const string ProjectionAll = "all";
    public const string ProjectionFiltered = "filtered";
    public const string ProjectionSelection = "selection";

    public const string ContinuationSource = "source";
    public const string ContinuationExactSnapshot = "exactSnapshot";
    public const string ContinuationLiveRerun = "liveRerun";
    public const string ContinuationEnrichment = "enrichment";

    /// <summary>Names the generated enrichment cell defines. A prompt may not reuse one.</summary>
    public static readonly ImmutableArray<string> EnrichmentReservedNames =
    [
        "LocalResult",
        "ClickedColumn",
        "ClickedValue",
        "SelectedColumns"
    ];
}

[DataContract]
public sealed class StartResultSessionParams
{
    [DataMember(Name = "protocolVersion")]
    public required int ProtocolVersion { get; init; }

    [DataMember(Name = "query")]
    public required string Query { get; init; }

    [DataMember(Name = "cluster")]
    public string? Cluster { get; init; }

    [DataMember(Name = "database")]
    public string? Database { get; init; }

    [DataMember(Name = "isReadOnly")]
    public bool? IsReadOnly { get; init; }

    [DataMember(Name = "maxRows")]
    public long? MaxRows { get; init; }

    [DataMember(Name = "clientRequestId")]
    public string? ClientRequestId { get; init; }
}

[DataContract]
public sealed class StartResultSessionResult
{
    [DataMember(Name = "protocolVersion")]
    public required int ProtocolVersion { get; init; }

    [DataMember(Name = "operationId")]
    public required string OperationId { get; init; }

    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }
}

[DataContract]
public sealed class CancelResultSessionOperationParams
{
    [DataMember(Name = "operationId")]
    public required string OperationId { get; init; }
}

[DataContract]
public sealed class CancelResultSessionOperationResult
{
    [DataMember(Name = "accepted")]
    public required bool Accepted { get; init; }
}

[DataContract]
public sealed class GetResultSessionStatusParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }
}

[DataContract]
public sealed class ResultSessionStatus
{
    [DataMember(Name = "protocolVersion")]
    public required int ProtocolVersion { get; init; }

    [DataMember(Name = "operationId")]
    public required string OperationId { get; init; }

    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "state")]
    public required string State { get; init; }

    [DataMember(Name = "tables")]
    public required ImmutableList<ResultSessionTableStatus> Tables { get; init; }

    [DataMember(Name = "connection")]
    public string? Connection { get; init; }

    [DataMember(Name = "provenance")]
    public ResultSessionProvenance? Provenance { get; init; }

    [DataMember(Name = "error")]
    public ResultSessionDiagnostic? Error { get; init; }
}

[DataContract]
public sealed class ResultSessionTableStatus
{
    [DataMember(Name = "id")]
    public required string Id { get; init; }

    [DataMember(Name = "name")]
    public required string Name { get; init; }

    [DataMember(Name = "columns")]
    public required ImmutableList<ResultSessionColumn> Columns { get; init; }

    [DataMember(Name = "rowsRead")]
    public required long RowsRead { get; init; }

    [DataMember(Name = "totalRows")]
    public long? TotalRows { get; init; }

    [DataMember(Name = "isComplete")]
    public required bool IsComplete { get; init; }

    [DataMember(Name = "view")]
    public ResultSessionViewStatus? View { get; init; }
}

[DataContract]
public sealed class ResultSessionColumn
{
    [DataMember(Name = "name")]
    public required string Name { get; init; }

    [DataMember(Name = "type")]
    public required string Type { get; init; }
}

[DataContract]
public sealed class ResultSessionViewStatus
{
    [DataMember(Name = "revision")]
    public required long Revision { get; init; }

    [DataMember(Name = "state")]
    public required string State { get; init; }

    [DataMember(Name = "matchedRows")]
    public long? MatchedRows { get; init; }

    [DataMember(Name = "filters")]
    public ImmutableList<ResultSessionColumnFilterStatus>? Filters { get; init; }

    [DataMember(Name = "error")]
    public ResultSessionDiagnostic? Error { get; init; }

    [DataMember(Name = "readyRevision")]
    public long? ReadyRevision { get; init; }

    [DataMember(Name = "readyMatchedRows")]
    public long? ReadyMatchedRows { get; init; }

    [DataMember(Name = "readyFilters")]
    public ImmutableList<ResultSessionColumnFilter>? ReadyFilters { get; init; }

    [DataMember(Name = "readySorts")]
    public ImmutableList<ResultSessionColumnSort>? ReadySorts { get; init; }
}

[DataContract]
public sealed class ResultSessionColumnFilterStatus
{
    [DataMember(Name = "columnIndex")]
    public required int ColumnIndex { get; init; }

    [DataMember(Name = "state")]
    public required string State { get; init; }

    [DataMember(Name = "error")]
    public ResultSessionDiagnostic? Error { get; init; }
}

[DataContract]
public sealed class ResultSessionProvenance
{
    [DataMember(Name = "query")]
    public required string Query { get; init; }

    [DataMember(Name = "cluster")]
    public string? Cluster { get; init; }

    [DataMember(Name = "database")]
    public string? Database { get; init; }

    [DataMember(Name = "executionStartedAt")]
    public required string ExecutionStartedAt { get; init; }

    [DataMember(Name = "executionCompletedAt")]
    public string? ExecutionCompletedAt { get; init; }

    [DataMember(Name = "clientRequestId")]
    public string? ClientRequestId { get; init; }

    [DataMember(Name = "notebookUri")]
    public string? NotebookUri { get; init; }

    [DataMember(Name = "cellId")]
    public string? CellId { get; init; }

    [DataMember(Name = "continuationKind")]
    public string? ContinuationKind { get; init; }

    [DataMember(Name = "isStaleSinceSnapshot")]
    public bool? IsStaleSinceSnapshot { get; init; }
}

[DataContract]
public sealed class ResultSessionDiagnostic
{
    [DataMember(Name = "message")]
    public required string Message { get; init; }

    [DataMember(Name = "details")]
    public string? Details { get; init; }

    [DataMember(Name = "range")]
    public LSP.Range? Range { get; init; }
}

[DataContract]
public sealed class SetResultSessionViewParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "revision")]
    public required long Revision { get; init; }

    [DataMember(Name = "filters")]
    public required ImmutableList<ResultSessionColumnFilter> Filters { get; init; }

    [DataMember(Name = "sorts")]
    public required ImmutableList<ResultSessionColumnSort> Sorts { get; init; }
}

[DataContract]
public sealed class ResultSessionColumnFilter
{
    [DataMember(Name = "columnIndex")]
    public required int ColumnIndex { get; init; }

    [DataMember(Name = "pattern")]
    public required string Pattern { get; init; }

    [DataMember(Name = "caseSensitive")]
    public required bool CaseSensitive { get; init; }
}

[DataContract]
public sealed class ResultSessionColumnSort
{
    [DataMember(Name = "columnIndex")]
    public required int ColumnIndex { get; init; }

    [DataMember(Name = "direction")]
    public required string Direction { get; init; }
}

[DataContract]
public sealed class SetResultSessionViewResult
{
    [DataMember(Name = "accepted")]
    public required bool Accepted { get; init; }

    [DataMember(Name = "revision")]
    public required long Revision { get; init; }
}

[DataContract]
public sealed class GetResultSessionPageParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    [DataMember(Name = "offset")]
    public required long Offset { get; init; }

    [DataMember(Name = "count")]
    // Implementations must reject values outside 1..ResultSessionProtocol.MaxPageSize.
    public required int Count { get; init; }
}

[DataContract]
public sealed class ResultSessionPage
{
    [DataMember(Name = "protocolVersion")]
    public required int ProtocolVersion { get; init; }

    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    [DataMember(Name = "offset")]
    public required long Offset { get; init; }

    [DataMember(Name = "rows")]
    public required ImmutableList<ResultSessionRow> Rows { get; init; }

    [DataMember(Name = "viewRows")]
    public required long ViewRows { get; init; }
}

[DataContract]
public sealed class ResultSessionRow
{
    [DataMember(Name = "sourceIndex")]
    public required long SourceIndex { get; init; }

    [DataMember(Name = "values")]
    public required ImmutableList<object?> Values { get; init; }
}

[DataContract]
public sealed class GetResultSessionProjectionParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    [DataMember(Name = "scope")]
    public required string Scope { get; init; }

    [DataMember(Name = "rowRanges")]
    public ImmutableList<ResultSessionRowRange>? RowRanges { get; init; }

    [DataMember(Name = "columnIndexes")]
    public required ImmutableList<int> ColumnIndexes { get; init; }

    [DataMember(Name = "offset")]
    public required long Offset { get; init; }

    [DataMember(Name = "count")]
    // Implementations must reject values outside 1..ResultSessionProtocol.MaxProjectionPageSize.
    public required int Count { get; init; }
}

[DataContract]
public sealed class ResultSessionRowRange
{
    [DataMember(Name = "offset")]
    public required long Offset { get; init; }

    [DataMember(Name = "count")]
    public required long Count { get; init; }
}

[DataContract]
public sealed class ResultSessionProjection
{
    [DataMember(Name = "protocolVersion")]
    public required int ProtocolVersion { get; init; }

    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    [DataMember(Name = "columns")]
    public required ImmutableList<ResultSessionColumn> Columns { get; init; }

    [DataMember(Name = "rows")]
    public required ImmutableList<ResultSessionRow> Rows { get; init; }

    [DataMember(Name = "offset")]
    public required long Offset { get; init; }

    [DataMember(Name = "projectedRows")]
    public required long ProjectedRows { get; init; }

    [DataMember(Name = "hasMore")]
    public required bool HasMore { get; init; }
}

[DataContract]
public sealed class CreateResultSessionContinuationParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    [DataMember(Name = "scope")]
    public required string Scope { get; init; }

    [DataMember(Name = "rowRanges")]
    public ImmutableList<ResultSessionRowRange>? RowRanges { get; init; }

    [DataMember(Name = "columnIndexes")]
    public required ImmutableList<int> ColumnIndexes { get; init; }
}

[DataContract]
public sealed class CreateResultSessionContinuationResult
{
    [DataMember(Name = "snapshotQuery")]
    public string? SnapshotQuery { get; init; }

    [DataMember(Name = "snapshotTextBytes")]
    public required long SnapshotTextBytes { get; init; }

    [DataMember(Name = "queryTextBudgetBytes")]
    public required int QueryTextBudgetBytes { get; init; }

    [DataMember(Name = "projectedRows")]
    public required long ProjectedRows { get; init; }

    [DataMember(Name = "liveRerunQuery")]
    public string? LiveRerunQuery { get; init; }

    [DataMember(Name = "liveRerunTextBytes")]
    public long? LiveRerunTextBytes { get; init; }

    [DataMember(Name = "liveRerunUnavailableReason")]
    public string? LiveRerunUnavailableReason { get; init; }
}

[DataContract]
public sealed class CreateResultSessionEnrichmentParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }

    [DataMember(Name = "tableId")]
    public required string TableId { get; init; }

    [DataMember(Name = "viewRevision")]
    public required long ViewRevision { get; init; }

    /// <summary>Ordered, non-overlapping view row ranges covering the enrichment input rows.</summary>
    [DataMember(Name = "rowRanges")]
    public required ImmutableList<ResultSessionRowRange> RowRanges { get; init; }

    [DataMember(Name = "columnIndexes")]
    public required ImmutableList<int> ColumnIndexes { get; init; }

    /// <summary>View index of the right-clicked row, used for context and column-bound prompts.</summary>
    [DataMember(Name = "clickedRowIndex")]
    public required long ClickedRowIndex { get; init; }

    [DataMember(Name = "clickedColumnIndex")]
    public required int ClickedColumnIndex { get; init; }

    [DataMember(Name = "selectedColumnIndexes")]
    public required ImmutableList<int> SelectedColumnIndexes { get; init; }

    [DataMember(Name = "prompts")]
    public required ImmutableList<ResultSessionEnrichmentPrompt> Prompts { get; init; }

    /// <summary>Snippet KQL, appended verbatim after the generated declarations.</summary>
    [DataMember(Name = "snippet")]
    public required string Snippet { get; init; }
}

[DataContract]
public sealed class ResultSessionEnrichmentPrompt
{
    [DataMember(Name = "name")]
    public required string Name { get; init; }

    /// <summary>Declared Kusto scalar type. Only <c>string</c> values are quoted and escaped.</summary>
    [DataMember(Name = "type")]
    public string? Type { get; init; }

    /// <summary>Manually entered value. Ignored when <see cref="ColumnIndex"/> is set.</summary>
    [DataMember(Name = "text")]
    public string? Text { get; init; }

    /// <summary>Binds the prompt to the right-clicked row's value in this column.</summary>
    [DataMember(Name = "columnIndex")]
    public int? ColumnIndex { get; init; }
}

[DataContract]
public sealed class CreateResultSessionEnrichmentResult
{
    /// <summary>Generated cell text, or null when it does not fit the query-text budget.</summary>
    [DataMember(Name = "query")]
    public string? Query { get; init; }

    [DataMember(Name = "queryTextBytes")]
    public required long QueryTextBytes { get; init; }

    [DataMember(Name = "queryTextBudgetBytes")]
    public required int QueryTextBudgetBytes { get; init; }

    [DataMember(Name = "projectedRows")]
    public required long ProjectedRows { get; init; }
}

[DataContract]
public sealed class DisposeResultSessionParams
{
    [DataMember(Name = "sessionId")]
    public required string SessionId { get; init; }
}

[DataContract]
public sealed class DisposeResultSessionResult
{
    [DataMember(Name = "disposed")]
    public required bool Disposed { get; init; }
}
