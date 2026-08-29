// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Data;
using System.Globalization;
using System.Text.RegularExpressions;
using Kusto.Data.Common;
using Kusto.Language.Editor;

namespace Kusto.Vscode;

/// <summary>
/// Owns typed query results in the server process and exposes bounded, revisioned reads.
/// </summary>
public sealed class ResultSessionManager : IResultSessionManager
{
    private static readonly TimeSpan DefaultIdleTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan RegexMatchTimeout = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan ViewEvaluationTimeout = TimeSpan.FromSeconds(5);
    private const int MaximumRegexPatternLength = 4_096;
    private const int DefaultMaximumSessions = 64;

    private readonly IQueryManager _queryManager;
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly object _sessionGate = new();
    private readonly TimeSpan _idleTimeout;
    private readonly int _maximumSessions;
    private readonly Timer _cleanupTimer;
    private bool _disposed;

    public ResultSessionManager(IQueryManager queryManager)
        : this(queryManager, DefaultIdleTimeout, DefaultMaximumSessions)
    {
    }

    internal ResultSessionManager(
        IQueryManager queryManager,
        TimeSpan idleTimeout,
        int maximumSessions)
    {
        ArgumentNullException.ThrowIfNull(queryManager);
        if (idleTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(idleTimeout));
        if (maximumSessions <= 0)
            throw new ArgumentOutOfRangeException(nameof(maximumSessions));

        _queryManager = queryManager;
        _idleTimeout = idleTimeout;
        _maximumSessions = maximumSessions;
        var cleanupPeriod = idleTimeout < TimeSpan.FromMinutes(1)
            ? idleTimeout
            : TimeSpan.FromMinutes(1);
        _cleanupTimer = new Timer(_ => CleanupIdleSessions(), null, cleanupPeriod, cleanupPeriod);
    }

    public Task<StartResultSessionResult> StartAsync(StartResultSessionParams parameters)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.ProtocolVersion != ResultSessionProtocol.Version)
            throw new ArgumentException(
                $"Unsupported result-session protocol version {parameters.ProtocolVersion}.",
                nameof(parameters));
        if (parameters.Query == null)
            throw new ArgumentException("A query is required.", nameof(parameters));
        if (parameters.MaxRows is <= 0)
            throw new ArgumentOutOfRangeException(nameof(parameters), "maxRows must be positive.");

        var operationId = Guid.NewGuid().ToString("N");
        var sessionId = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var session = new Session(
            operationId,
            sessionId,
            parameters,
            now);

        lock (_sessionGate)
        {
            ThrowIfDisposed();
            EnforceSessionLimit();
            if (!_sessions.TryAdd(sessionId, session))
                throw new InvalidOperationException("Could not allocate a result session.");
        }

        session.ExecutionTask = Task.Run(() => ExecuteAsync(session));
        _ = session.ExecutionTask.ContinueWith(
            task => RecordExecutionFailure(session, task.Exception!.GetBaseException()),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
        return Task.FromResult(new StartResultSessionResult
        {
            ProtocolVersion = ResultSessionProtocol.Version,
            OperationId = operationId,
            SessionId = sessionId
        });
    }

    public Task<CancelResultSessionOperationResult> CancelAsync(
        CancelResultSessionOperationParams parameters)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);

        var session = _sessions.Values.FirstOrDefault(
            candidate => string.Equals(
                candidate.OperationId,
                parameters.OperationId,
                StringComparison.Ordinal));
        if (session == null)
            return Task.FromResult(new CancelResultSessionOperationResult { Accepted = false });

        bool accepted;
        lock (session.SyncRoot)
        {
            session.Touch();
            accepted = IsActive(session.State);
        }

        if (accepted)
            session.Cancellation.Cancel();

        return Task.FromResult(new CancelResultSessionOperationResult { Accepted = accepted });
    }

    public Task<ResultSessionStatus> GetStatusAsync(
        GetResultSessionStatusParams parameters)
    {
        ThrowIfDisposed();
        var session = GetSession(parameters?.SessionId);

        lock (session.SyncRoot)
        {
            session.Touch();
            return Task.FromResult(CreateStatus(session));
        }
    }

    public async Task<SetResultSessionViewResult> SetViewAsync(
        SetResultSessionViewParams parameters,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);
        cancellationToken.ThrowIfCancellationRequested();
        var session = GetSession(parameters.SessionId);

        SessionTable table;
        ViewEvaluation? evaluation;
        ImmutableList<CompiledFilter> compiledFilters;
        lock (session.SyncRoot)
        {
            session.Touch();
            table = GetCompletedTable(session, parameters.TableId);

            if (parameters.Revision != table.ViewRevision + 1)
            {
                return new SetResultSessionViewResult
                {
                    Accepted = false,
                    Revision = table.ViewRevision
                };
            }

            ValidateFilterColumns(table, parameters.Filters);
            ValidateSorts(table, parameters.Sorts);

            compiledFilters = CompileFilters(parameters.Filters);
            table.CancelViewEvaluation();
            table.ViewRevision = parameters.Revision;
            table.ViewMatchedRows = null;
            table.FilterStatuses = compiledFilters
                .Select(filter => filter.Status)
                .ToImmutableList();

            var invalidFilter = compiledFilters.FirstOrDefault(filter => filter.Regex == null);
            if (invalidFilter != null)
            {
                table.ViewState = ResultSessionContractValues.ViewStateFailed;
                table.ViewError = new ResultSessionDiagnostic
                {
                    Message = $"Filter for column {invalidFilter.Filter.ColumnIndex} has an invalid regular expression.",
                    Details = invalidFilter.Status.Error?.Message
                };
                return new SetResultSessionViewResult
                {
                    Accepted = true,
                    Revision = table.ViewRevision
                };
            }

            evaluation = new ViewEvaluation();
            table.ViewEvaluation = evaluation;
            table.ViewState = ResultSessionContractValues.ViewStateEvaluating;
            table.ViewError = null;
        }

        ViewEvaluationResult? result = null;
        ResultSessionDiagnostic? evaluationFailure = null;
        CancellationTokenSource? evaluationTimeout = null;
        var readyViewPublished = false;
        try
        {
            evaluationTimeout = new CancellationTokenSource(ViewEvaluationTimeout);
            using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                session.Cancellation.Token,
                evaluation.Cancellation.Token,
                evaluationTimeout.Token);
            result = await Task.Run(
                () => EvaluateView(
                    table,
                    compiledFilters,
                    parameters.Sorts,
                    linkedCancellation.Token),
                linkedCancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (evaluationTimeout?.IsCancellationRequested == true
                && !cancellationToken.IsCancellationRequested
                && !session.Cancellation.IsCancellationRequested
                && !evaluation.Cancellation.IsCancellationRequested)
        {
            evaluationFailure = new ResultSessionDiagnostic
            {
                Message = $"Filtering exceeded the {ViewEvaluationTimeout.TotalSeconds:0}-second safety limit."
            };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A newer revision or disposal superseded this evaluation.
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            evaluationFailure = new ResultSessionDiagnostic
            {
                Message = "The result view could not be evaluated.",
                Details = exception.Message
            };
        }
        finally
        {
            lock (session.SyncRoot)
            {
                if (ReferenceEquals(table.ViewEvaluation, evaluation))
                {
                    table.ViewEvaluation = null;
                    if (result?.TimedOutFilterIndex is int timedOutFilterIndex)
                    {
                        var timedOutFilter = parameters.Filters[timedOutFilterIndex];
                        var diagnostic = new ResultSessionDiagnostic
                        {
                            Message = $"Regular expression matching timed out after {RegexMatchTimeout.TotalMilliseconds:0} ms."
                        };
                        table.FilterStatuses = table.FilterStatuses.SetItem(
                            timedOutFilterIndex,
                            new ResultSessionColumnFilterStatus
                            {
                                ColumnIndex = timedOutFilter.ColumnIndex,
                                State = ResultSessionContractValues.FilterStateInvalid,
                                Error = diagnostic
                            });
                        table.ViewState = ResultSessionContractValues.ViewStateFailed;
                        table.ViewMatchedRows = null;
                        table.ViewError = new ResultSessionDiagnostic
                        {
                            Message = $"Filter for column {timedOutFilter.ColumnIndex} timed out.",
                            Details = diagnostic.Message
                        };
                    }
                    else if (result != null
                        && session.State == ResultSessionContractValues.StateCompleted
                        && !cancellationToken.IsCancellationRequested
                        && !session.Cancellation.IsCancellationRequested
                        && !evaluation.Cancellation.IsCancellationRequested)
                    {
                        table.ViewSourceIndexes = result.SourceIndexes;
                        table.ReadyViewRevision = parameters.Revision;
                        table.ViewMatchedRows = result.SourceIndexes.LongLength;
                        table.ViewState = ResultSessionContractValues.ViewStateReady;
                        table.ViewError = null;
                        table.Filters = parameters.Filters;
                        table.Sorts = parameters.Sorts;
                        readyViewPublished = true;
                    }
                    else if (evaluationFailure != null
                        && session.State == ResultSessionContractValues.StateCompleted)
                    {
                        table.ViewState = ResultSessionContractValues.ViewStateFailed;
                        table.ViewMatchedRows = null;
                        table.ViewError = evaluationFailure;
                    }
                    else if (cancellationToken.IsCancellationRequested
                        && session.State == ResultSessionContractValues.StateCompleted)
                    {
                        table.ViewState = ResultSessionContractValues.ViewStateFailed;
                        table.ViewMatchedRows = null;
                        table.ViewError = new ResultSessionDiagnostic
                        {
                            Message = "The result view evaluation was cancelled."
                        };
                    }
                }
            }
            evaluationTimeout?.Dispose();
            evaluation.Dispose();
        }

        if (!readyViewPublished)
            cancellationToken.ThrowIfCancellationRequested();
        return new SetResultSessionViewResult
        {
            Accepted = true,
            Revision = parameters.Revision
        };
    }

    public Task<ResultSessionPage> GetPageAsync(
        GetResultSessionPageParams parameters,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);
        ValidatePage(parameters.Offset, parameters.Count, ResultSessionProtocol.MaxPageSize);
        var session = GetSession(parameters.SessionId);

        lock (session.SyncRoot)
        {
            session.Touch();
            var table = GetCompletedTable(session, parameters.TableId);
            ValidateViewRevision(table, parameters.ViewRevision);
            ValidateOffset(parameters.Offset, table.ViewSourceIndexes.LongLength);
            cancellationToken.ThrowIfCancellationRequested();

            var available = table.ViewSourceIndexes.LongLength - parameters.Offset;
            var rowCount = (int)Math.Min(parameters.Count, available);
            var rows = CreateRows(
                table,
                table.ViewSourceIndexes,
                parameters.Offset,
                rowCount,
                columnIndexes: null,
                cancellationToken);

            return Task.FromResult(new ResultSessionPage
            {
                ProtocolVersion = ResultSessionProtocol.Version,
                SessionId = session.SessionId,
                TableId = table.Id,
                ViewRevision = table.ReadyViewRevision,
                Offset = parameters.Offset,
                Rows = rows,
                ViewRows = table.ViewSourceIndexes.LongLength
            });
        }
    }

    public Task<ResultSessionProjection> GetProjectionAsync(
        GetResultSessionProjectionParams parameters,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);
        ValidatePage(
            parameters.Offset,
            parameters.Count,
            ResultSessionProtocol.MaxProjectionPageSize);
        var session = GetSession(parameters.SessionId);

        lock (session.SyncRoot)
        {
            session.Touch();
            var table = GetCompletedTable(session, parameters.TableId);
            ValidateViewRevision(table, parameters.ViewRevision);
            ValidateColumnIndexes(table, parameters.ColumnIndexes);
            var projectionMap = GetProjectionMap(table, parameters);
            ValidateOffset(parameters.Offset, projectionMap.Count);
            cancellationToken.ThrowIfCancellationRequested();

            var available = projectionMap.Count - parameters.Offset;
            var rowCount = (int)Math.Min(parameters.Count, available);
            var rows = CreateRows(
                table,
                projectionMap.GetSourceIndex,
                parameters.Offset,
                rowCount,
                parameters.ColumnIndexes,
                cancellationToken);
            var columns = parameters.ColumnIndexes
                .Select(index => table.Columns[index])
                .ToImmutableList();

            return Task.FromResult(new ResultSessionProjection
            {
                ProtocolVersion = ResultSessionProtocol.Version,
                SessionId = session.SessionId,
                TableId = table.Id,
                ViewRevision = table.ReadyViewRevision,
                Columns = columns,
                Rows = rows,
                Offset = parameters.Offset,
                ProjectedRows = projectionMap.Count,
                HasMore = parameters.Offset + rowCount < projectionMap.Count
            });
        }
    }

    public Task<DisposeResultSessionResult> DisposeAsync(
        DisposeResultSessionParams parameters)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(parameters);

        if (!_sessions.TryGetValue(parameters.SessionId, out var session))
            return Task.FromResult(new DisposeResultSessionResult { Disposed = false });

        var disposed = DisposeSession(session);
        return Task.FromResult(new DisposeResultSessionResult { Disposed = disposed });
    }

    public void Dispose()
    {
        lock (_sessionGate)
        {
            if (_disposed)
                return;

            _disposed = true;
            _cleanupTimer.Dispose();
            foreach (var session in _sessions.Values)
                DisposeSession(session);
            _sessions.Clear();
        }
    }

    private async Task ExecuteAsync(Session session)
    {
        try
        {
            lock (session.SyncRoot)
            {
                if (session.State == ResultSessionContractValues.StateDisposed)
                    return;
                session.State = ResultSessionContractValues.StateRunning;
            }

            var options = ImmutableDictionary<string, string>.Empty;
            if (session.Parameters.IsReadOnly == true)
            {
                options = options.Add(
                    ClientRequestProperties.OptionRequestReadOnly,
                    "true");
            }
            if (session.Parameters.MaxRows.HasValue)
            {
                options = options.Add(
                    ClientRequestProperties.OptionTakeMaxRecords,
                    session.Parameters.MaxRows.Value.ToString(CultureInfo.InvariantCulture));
            }

            var runResult = await _queryManager.RunQueryAsync(
                new EditString(session.Parameters.Query),
                session.Parameters.Cluster,
                session.Parameters.Database,
                options,
                ImmutableDictionary<string, string>.Empty,
                session.Parameters.ClientRequestId,
                session.Parameters.MaxRows,
                session.Cancellation.Token).ConfigureAwait(false);

            if (session.Cancellation.IsCancellationRequested)
            {
                DisposeTables(runResult.ExecuteResult?.Tables);
                session.Cancellation.Token.ThrowIfCancellationRequested();
            }

            lock (session.SyncRoot)
            {
                if (session.State == ResultSessionContractValues.StateDisposed)
                {
                    DisposeTables(runResult.ExecuteResult?.Tables);
                    return;
                }
                if (session.Cancellation.IsCancellationRequested)
                {
                    DisposeTables(runResult.ExecuteResult?.Tables);
                    session.Cancellation.Token.ThrowIfCancellationRequested();
                }

                if (runResult.Error != null)
                {
                    DisposeTables(runResult.ExecuteResult?.Tables);
                    session.State = ResultSessionContractValues.StateFailed;
                    session.Error = new ResultSessionDiagnostic
                    {
                        Message = runResult.Error.Message,
                        Details = runResult.Error.Description
                    };
                    session.ExecutionCompletedAt = DateTimeOffset.UtcNow;
                    return;
                }

                session.State = ResultSessionContractValues.StateMaterializing;
                var tables = runResult.ExecuteResult?.Tables
                    ?? ImmutableList<DataTable>.Empty;
                session.OwnedTables = tables;
                session.Tables = tables
                    .Select((data, index) => new SessionTable($"table-{index}", data))
                    .ToImmutableList();
                session.EffectiveCluster = runResult.Cluster ?? session.Parameters.Cluster;
                session.EffectiveDatabase = runResult.Database ?? session.Parameters.Database;
                session.EffectiveConnection = runResult.Connection;
                session.ExecutionCompletedAt = DateTimeOffset.UtcNow;
                session.State = ResultSessionContractValues.StateCompleted;
            }
        }
        catch (OperationCanceledException)
        {
            lock (session.SyncRoot)
            {
                if (session.State != ResultSessionContractValues.StateDisposed)
                {
                    session.State = ResultSessionContractValues.StateCancelled;
                    session.Error = new ResultSessionDiagnostic
                    {
                        Message = "The result-session operation was cancelled."
                    };
                    session.ExecutionCompletedAt = DateTimeOffset.UtcNow;
                }
            }
        }
    }

    private static void RecordExecutionFailure(Session session, Exception exception)
    {
        lock (session.SyncRoot)
        {
            if (session.State != ResultSessionContractValues.StateDisposed)
            {
                DisposeTables(session.OwnedTables);
                session.OwnedTables = ImmutableList<DataTable>.Empty;
                session.Tables = ImmutableList<SessionTable>.Empty;
                session.State = ResultSessionContractValues.StateFailed;
                session.Error = new ResultSessionDiagnostic
                {
                    Message = exception.Message,
                    Details = exception.GetType().FullName
                };
                session.ExecutionCompletedAt = DateTimeOffset.UtcNow;
            }
        }
    }

    private static ResultSessionStatus CreateStatus(Session session)
    {
        return new ResultSessionStatus
        {
            ProtocolVersion = ResultSessionProtocol.Version,
            OperationId = session.OperationId,
            SessionId = session.SessionId,
            State = session.State,
            Tables = session.Tables.Select(CreateTableStatus).ToImmutableList(),
            Connection = session.EffectiveConnection,
            Provenance = new ResultSessionProvenance
            {
                Query = session.Parameters.Query,
                Cluster = session.EffectiveCluster ?? session.Parameters.Cluster,
                Database = session.EffectiveDatabase ?? session.Parameters.Database,
                ExecutionStartedAt = session.ExecutionStartedAt.ToString("O"),
                ExecutionCompletedAt = session.ExecutionCompletedAt?.ToString("O"),
                ClientRequestId = session.Parameters.ClientRequestId,
                ContinuationKind = ResultSessionContractValues.ContinuationSource,
                IsStaleSinceSnapshot = false
            },
            Error = session.Error
        };
    }

    private static ResultSessionTableStatus CreateTableStatus(SessionTable table)
    {
        return new ResultSessionTableStatus
        {
            Id = table.Id,
            Name = table.Data.TableName,
            Columns = table.Columns,
            RowsRead = table.Data.Rows.Count,
            TotalRows = table.Data.Rows.Count,
            IsComplete = true,
            View = new ResultSessionViewStatus
            {
                Revision = table.ViewRevision,
                State = table.ViewState,
                MatchedRows = table.ViewMatchedRows,
                Filters = table.FilterStatuses,
                Error = table.ViewError,
                ReadyRevision = table.ReadyViewRevision,
                ReadyMatchedRows = table.ViewSourceIndexes.LongLength,
                ReadyFilters = table.Filters,
                ReadySorts = table.Sorts
            }
        };
    }

    private Session GetSession(string? sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)
            || !_sessions.TryGetValue(sessionId, out var session))
        {
            throw new KeyNotFoundException($"Result session '{sessionId}' was not found.");
        }

        return session;
    }

    private static SessionTable GetCompletedTable(Session session, string tableId)
    {
        if (session.State != ResultSessionContractValues.StateCompleted)
            throw new InvalidOperationException(
                $"Result session '{session.SessionId}' is in state '{session.State}'.");

        return session.Tables.FirstOrDefault(
            table => string.Equals(table.Id, tableId, StringComparison.Ordinal))
            ?? throw new KeyNotFoundException($"Result table '{tableId}' was not found.");
    }

    private static void ValidateSorts(
        SessionTable table,
        ImmutableList<ResultSessionColumnSort> sorts)
    {
        var seen = new HashSet<int>();
        foreach (var sort in sorts)
        {
            if (sort.ColumnIndex < 0 || sort.ColumnIndex >= table.Data.Columns.Count)
                throw new ArgumentOutOfRangeException(nameof(sorts), "A sort column is out of range.");
            if (!seen.Add(sort.ColumnIndex))
                throw new ArgumentException("A sort column may only appear once.", nameof(sorts));
            if (sort.Direction != ResultSessionContractValues.SortAscending
                && sort.Direction != ResultSessionContractValues.SortDescending)
            {
                throw new ArgumentException(
                    $"Unknown sort direction '{sort.Direction}'.",
                    nameof(sorts));
            }
        }
    }

    private static void ValidateFilterColumns(
        SessionTable table,
        ImmutableList<ResultSessionColumnFilter> filters)
    {
        foreach (var filter in filters)
        {
            if (filter.ColumnIndex < 0 || filter.ColumnIndex >= table.Data.Columns.Count)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(filters),
                    "A filter column is out of range.");
            }
        }
    }

    private static ImmutableList<CompiledFilter> CompileFilters(
        ImmutableList<ResultSessionColumnFilter> filters)
    {
        return filters.Select(filter =>
        {
            if (filter.Pattern == null || filter.Pattern.Length > MaximumRegexPatternLength)
            {
                return new CompiledFilter(
                    filter,
                    null,
                    new ResultSessionColumnFilterStatus
                    {
                        ColumnIndex = filter.ColumnIndex,
                        State = ResultSessionContractValues.FilterStateInvalid,
                        Error = new ResultSessionDiagnostic
                        {
                            Message = $"Regular expressions must contain at most {MaximumRegexPatternLength} characters."
                        }
                    });
            }
            try
            {
                var options = RegexOptions.CultureInvariant;
                if (!filter.CaseSensitive)
                    options |= RegexOptions.IgnoreCase;
                var regex = new Regex(filter.Pattern, options, RegexMatchTimeout);
                return new CompiledFilter(
                    filter,
                    regex,
                    new ResultSessionColumnFilterStatus
                    {
                        ColumnIndex = filter.ColumnIndex,
                        State = ResultSessionContractValues.FilterStateValid
                    });
            }
            catch (ArgumentException exception)
            {
                return new CompiledFilter(
                    filter,
                    null,
                    new ResultSessionColumnFilterStatus
                    {
                        ColumnIndex = filter.ColumnIndex,
                        State = ResultSessionContractValues.FilterStateInvalid,
                        Error = new ResultSessionDiagnostic
                        {
                            Message = $"Invalid regular expression: {exception.Message}"
                        }
                    });
            }
        }).ToImmutableList();
    }

    private static ViewEvaluationResult EvaluateView(
        SessionTable table,
        ImmutableList<CompiledFilter> filters,
        ImmutableList<ResultSessionColumnSort> sorts,
        CancellationToken cancellationToken)
    {
        var sourceIndexes = new List<int>(table.Data.Rows.Count);
        for (var sourceIndex = 0; sourceIndex < table.Data.Rows.Count; sourceIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var row = table.Data.Rows[sourceIndex];
            var matches = true;
            for (var filterIndex = 0; filterIndex < filters.Count; filterIndex++)
            {
                var filter = filters[filterIndex];
                try
                {
                    if (!filter.Regex!.IsMatch(GetSearchText(
                        row[filter.Filter.ColumnIndex],
                        table.Columns[filter.Filter.ColumnIndex].Type)))
                    {
                        matches = false;
                        break;
                    }
                }
                catch (RegexMatchTimeoutException)
                {
                    return new ViewEvaluationResult([], filterIndex);
                }
            }

            if (matches)
                sourceIndexes.Add(sourceIndex);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var result = sourceIndexes.ToArray();
        if (sorts.Count != 0)
        {
            try
            {
                Array.Sort(
                    result,
                    new SourceIndexComparer(table.Data, sorts, cancellationToken));
            }
            catch (InvalidOperationException exception)
                when (exception.InnerException is OperationCanceledException)
            {
                throw new OperationCanceledException(cancellationToken);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new ViewEvaluationResult(result, null);
    }

    /// <summary>
    /// Produces the invariant text searched by filters from the same JSON-safe value sent on the wire.
    /// Null database values are represented by the empty string.
    /// </summary>
    private static string GetSearchText(object? value, string kustoType)
    {
        var converted = ConvertCellValue(value, kustoType);
        return converted switch
        {
            null => string.Empty,
            bool boolean => boolean ? "true" : "false",
            _ => Convert.ToString(converted, CultureInfo.InvariantCulture) ?? string.Empty
        };
    }

    private static void ValidatePage(long offset, int count, int maximumCount)
    {
        if (offset < 0)
            throw new ArgumentOutOfRangeException(nameof(offset));
        if (count < 1 || count > maximumCount)
            throw new ArgumentOutOfRangeException(nameof(count));
    }

    private static void ValidateOffset(long offset, long rowCount)
    {
        if (offset > rowCount)
            throw new ArgumentOutOfRangeException(nameof(offset));
    }

    private static void ValidateViewRevision(SessionTable table, long revision)
    {
        if (revision != table.ReadyViewRevision)
        {
            throw new InvalidOperationException(
                $"Stale result view revision {revision}; current ready revision is {table.ReadyViewRevision}.");
        }
    }

    private static void ValidateColumnIndexes(
        SessionTable table,
        ImmutableList<int> columnIndexes)
    {
        foreach (var index in columnIndexes)
        {
            if (index < 0 || index >= table.Data.Columns.Count)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(columnIndexes),
                    "A projected column is out of range.");
            }
        }
    }

    private static ProjectionMap GetProjectionMap(
        SessionTable table,
        GetResultSessionProjectionParams parameters)
    {
        switch (parameters.Scope)
        {
            case ResultSessionContractValues.ProjectionAll:
                if (parameters.RowRanges is { Count: > 0 })
                    throw new ArgumentException("rowRanges are only valid for selection projections.");
                return new ProjectionMap(
                    table.Data.Rows.Count,
                    position => checked((int)position));

            case ResultSessionContractValues.ProjectionFiltered:
                if (parameters.RowRanges is { Count: > 0 })
                    throw new ArgumentException("rowRanges are only valid for selection projections.");
                return new ProjectionMap(
                    table.ViewSourceIndexes.LongLength,
                    position => table.ViewSourceIndexes[position]);

            case ResultSessionContractValues.ProjectionSelection:
                if (parameters.RowRanges == null)
                    throw new ArgumentException("Selection projections require rowRanges.");

                long selectedCount = 0;
                foreach (var range in parameters.RowRanges)
                {
                    if (range.Offset < 0 || range.Count < 0)
                        throw new ArgumentOutOfRangeException(nameof(parameters.RowRanges));
                    if (range.Offset > table.ViewSourceIndexes.LongLength
                        || range.Count > table.ViewSourceIndexes.LongLength - range.Offset)
                    {
                        throw new ArgumentOutOfRangeException(
                            nameof(parameters.RowRanges),
                            "A selection row range is outside the current view.");
                    }
                    if (range.Count > long.MaxValue - selectedCount)
                        throw new ArgumentOutOfRangeException(nameof(parameters.RowRanges));
                    selectedCount += range.Count;
                }

                return new ProjectionMap(selectedCount, position =>
                {
                    foreach (var range in parameters.RowRanges)
                    {
                        if (position < range.Count)
                            return table.ViewSourceIndexes[range.Offset + position];
                        position -= range.Count;
                    }
                    throw new ArgumentOutOfRangeException(nameof(position));
                });

            default:
                throw new ArgumentException(
                    $"Unknown projection scope '{parameters.Scope}'.",
                    nameof(parameters));
        }
    }

    private static ImmutableList<ResultSessionRow> CreateRows(
        SessionTable table,
        int[] sourceIndexes,
        long offset,
        int count,
        ImmutableList<int>? columnIndexes,
        CancellationToken cancellationToken)
    {
        return CreateRows(
            table,
            position => sourceIndexes[position],
            offset,
            count,
            columnIndexes,
            cancellationToken);
    }

    private static ImmutableList<ResultSessionRow> CreateRows(
        SessionTable table,
        Func<long, int> getSourceIndex,
        long offset,
        int count,
        ImmutableList<int>? columnIndexes,
        CancellationToken cancellationToken)
    {
        var columns = columnIndexes ?? Enumerable.Range(0, table.Data.Columns.Count).ToImmutableList();
        var rows = ImmutableList.CreateBuilder<ResultSessionRow>();
        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var sourceIndex = getSourceIndex(offset + index);
            var dataRow = table.Data.Rows[sourceIndex];
            var values = columns
                .Select(columnIndex => ConvertCellValue(
                    dataRow[columnIndex],
                    table.Columns[columnIndex].Type))
                .ToImmutableList();
            rows.Add(new ResultSessionRow
            {
                SourceIndex = sourceIndex,
                Values = values
            });
        }
        return rows.ToImmutable();
    }

    private static object? ConvertCellValue(object? value, string kustoType)
    {
        var converted = ResultTable.ConvertCellValue(value, kustoType);
        if (converted == null)
            return null;
        return kustoType switch
        {
            "long" or "decimal" => Convert.ToString(converted, CultureInfo.InvariantCulture),
            "real" when converted is double real => real.ToString("R", CultureInfo.InvariantCulture),
            "real" when converted is float real => real.ToString("R", CultureInfo.InvariantCulture),
            _ => converted
        };
    }

    private void CleanupIdleSessions()
    {
        lock (_sessionGate)
        {
            if (_disposed)
                return;

            var cutoff = DateTimeOffset.UtcNow - _idleTimeout;
            foreach (var session in _sessions.Values)
            {
                lock (session.SyncRoot)
                {
                    if (session.LastAccess <= cutoff)
                    {
                        DisposeSession(session);
                        _sessions.TryRemove(session.SessionId, out _);
                    }
                }
            }
        }
    }

    private void EnforceSessionLimit()
    {
        CleanupIdleSessions();
        while (_sessions.Count >= _maximumSessions)
        {
            var oldest = _sessions.Values
                .Where(session => !IsActive(session.State))
                .OrderBy(session => session.LastAccess)
                .FirstOrDefault();
            if (oldest == null)
            {
                throw new InvalidOperationException(
                    "The maximum number of active result sessions has been reached.");
            }
            DisposeSession(oldest);
            _sessions.TryRemove(oldest.SessionId, out _);
        }
    }

    private bool DisposeSession(Session session)
    {
        Task? executionTask;
        lock (session.SyncRoot)
        {
            if (session.State == ResultSessionContractValues.StateDisposed)
                return false;

            session.State = ResultSessionContractValues.StateDisposed;
            session.Touch();
            foreach (var table in session.Tables)
                table.CancelViewEvaluation();
            DisposeTables(session.OwnedTables);
            session.OwnedTables = ImmutableList<DataTable>.Empty;
            session.Tables = ImmutableList<SessionTable>.Empty;
            executionTask = session.ExecutionTask;
        }

        session.Cancellation.Cancel();
        if (executionTask == null || executionTask.IsCompleted)
        {
            session.Cancellation.Dispose();
        }
        else
        {
            _ = executionTask.ContinueWith(
                _ => session.Cancellation.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        return true;
    }

    private static void DisposeTables(ImmutableList<DataTable>? tables)
    {
        if (tables == null)
            return;
        foreach (var table in tables)
            table.Dispose();
    }

    private static bool IsActive(string state)
    {
        return state == ResultSessionContractValues.StateQueued
            || state == ResultSessionContractValues.StateRunning
            || state == ResultSessionContractValues.StateMaterializing;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    private sealed class Session
    {
        public Session(
            string operationId,
            string sessionId,
            StartResultSessionParams parameters,
            DateTimeOffset now)
        {
            OperationId = operationId;
            SessionId = sessionId;
            Parameters = parameters;
            ExecutionStartedAt = now;
            LastAccess = now;
        }

        public object SyncRoot { get; } = new();
        public string OperationId { get; }
        public string SessionId { get; }
        public StartResultSessionParams Parameters { get; }
        public CancellationTokenSource Cancellation { get; } = new();
        public Task? ExecutionTask { get; set; }
        public string State { get; set; } = ResultSessionContractValues.StateQueued;
        public ImmutableList<DataTable> OwnedTables { get; set; } = ImmutableList<DataTable>.Empty;
        public ImmutableList<SessionTable> Tables { get; set; } = ImmutableList<SessionTable>.Empty;
        public ResultSessionDiagnostic? Error { get; set; }
        public DateTimeOffset ExecutionStartedAt { get; }
        public DateTimeOffset? ExecutionCompletedAt { get; set; }
        public string? EffectiveCluster { get; set; }
        public string? EffectiveDatabase { get; set; }
        public string? EffectiveConnection { get; set; }
        public DateTimeOffset LastAccess { get; private set; }

        public void Touch() => LastAccess = DateTimeOffset.UtcNow;
    }

    private sealed class SessionTable
    {
        public SessionTable(string id, DataTable data)
        {
            Id = id;
            Data = data;
            Columns = data.Columns
                .OfType<DataColumn>()
                .Select(column => new ResultSessionColumn
                {
                    Name = column.ColumnName,
                    Type = KustoGenerator.GetKustoSymbol(column.DataType).Name
                })
                .ToImmutableList();
            ViewSourceIndexes = Enumerable.Range(0, data.Rows.Count).ToArray();
            ViewMatchedRows = data.Rows.Count;
        }

        public string Id { get; }
        public DataTable Data { get; }
        public ImmutableList<ResultSessionColumn> Columns { get; }
        public int[] ViewSourceIndexes { get; set; }
        public long ViewRevision { get; set; }
        public long ReadyViewRevision { get; set; }
        public string ViewState { get; set; } = ResultSessionContractValues.ViewStateNone;
        public long? ViewMatchedRows { get; set; }
        public ImmutableList<ResultSessionColumnFilterStatus> FilterStatuses { get; set; }
            = ImmutableList<ResultSessionColumnFilterStatus>.Empty;
        public ResultSessionDiagnostic? ViewError { get; set; }
        public ViewEvaluation? ViewEvaluation { get; set; }
        public ImmutableList<ResultSessionColumnFilter> Filters { get; set; }
            = ImmutableList<ResultSessionColumnFilter>.Empty;
        public ImmutableList<ResultSessionColumnSort> Sorts { get; set; }
            = ImmutableList<ResultSessionColumnSort>.Empty;

        public void CancelViewEvaluation()
        {
            ViewEvaluation?.Cancel();
            ViewEvaluation = null;
        }
    }

    private sealed class SourceIndexComparer(
        DataTable table,
        ImmutableList<ResultSessionColumnSort> sorts,
        CancellationToken cancellationToken = default) : IComparer<int>
    {
        public int Compare(int left, int right)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var sort in sorts)
            {
                var comparison = CompareValues(
                    table.Rows[left][sort.ColumnIndex],
                    table.Rows[right][sort.ColumnIndex]);
                if (comparison != 0)
                {
                    return sort.Direction == ResultSessionContractValues.SortDescending
                        ? -comparison
                        : comparison;
                }

            }

            return left.CompareTo(right);
        }

        private static int CompareValues(object? left, object? right)
        {
            var leftIsNull = left == null || left == DBNull.Value;
            var rightIsNull = right == null || right == DBNull.Value;
            if (leftIsNull)
                return rightIsNull ? 0 : -1;
            if (rightIsNull)
                return 1;

            if (left is IComparable comparable)
                return comparable.CompareTo(right);

            return StringComparer.Ordinal.Compare(
                Convert.ToString(left, CultureInfo.InvariantCulture),
                Convert.ToString(right, CultureInfo.InvariantCulture));
        }
    }

    private readonly record struct ProjectionMap(
        long Count,
        Func<long, int> GetSourceIndex);

    private sealed record CompiledFilter(
        ResultSessionColumnFilter Filter,
        Regex? Regex,
        ResultSessionColumnFilterStatus Status);

    private sealed record ViewEvaluationResult(
        int[] SourceIndexes,
        int? TimedOutFilterIndex);

    private sealed class ViewEvaluation : IDisposable
    {
        public CancellationTokenSource Cancellation { get; } = new();

        public void Cancel() => Cancellation.Cancel();

        public void Dispose() => Cancellation.Dispose();
    }
}
