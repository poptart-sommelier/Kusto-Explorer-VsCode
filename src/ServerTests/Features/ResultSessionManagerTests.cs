// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Data;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Text;
using Kusto.Data.Common;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Vscode;

namespace Tests.Features;

[TestClass]
public class ResultSessionManagerTests
{
    [TestMethod]
    public async Task FullLifecycle_RetainsMultipleTypedTablesAndProjectsBoundedRows()
    {
        var gate = new TaskCompletionSource<RunResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var queryManager = new StubQueryManager((_, cancellationToken) =>
            gate.Task.WaitAsync(cancellationToken));
        using var manager = new ResultSessionManager(queryManager);

        var started = await manager.StartAsync(NewStart());

        Assert.AreEqual(ResultSessionProtocol.Version, started.ProtocolVersion);
        Assert.IsFalse(string.IsNullOrWhiteSpace(started.OperationId));
        Assert.IsFalse(string.IsNullOrWhiteSpace(started.SessionId));

        var first = new DataTable("First");
        first.Columns.Add("When", typeof(DateTime));
        first.Columns.Add("Value", typeof(int));
        first.Rows.Add(new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), 10);
        first.Rows.Add(DBNull.Value, 20);
        var second = new DataTable("Second");
        second.Columns.Add("Name", typeof(string));
        second.Rows.Add("other");
        gate.SetResult(Success("print Value=1", first, second));

        var status = await WaitForTerminalAsync(manager, started.SessionId);
        Assert.AreEqual(ResultSessionContractValues.StateCompleted, status.State);
        Assert.HasCount(2, status.Tables);
        Assert.AreEqual("First", status.Tables[0].Name);
        Assert.AreEqual(2, status.Tables[0].TotalRows);
        Assert.AreEqual("datetime", status.Tables[0].Columns[0].Type);
        Assert.AreEqual("cluster", status.Provenance?.Cluster);
        Assert.AreEqual("database", status.Provenance?.Database);
        Assert.AreEqual("request", status.Provenance?.ClientRequestId);
        Assert.IsNotNull(status.Provenance?.ExecutionCompletedAt);

        var page = await manager.GetPageAsync(new GetResultSessionPageParams
        {
            SessionId = started.SessionId,
            TableId = status.Tables[0].Id,
            ViewRevision = 0,
            Offset = 0,
            Count = 10
        }, CancellationToken.None);

        Assert.HasCount(2, page.Rows);
        Assert.AreEqual(0, page.Rows[0].SourceIndex);
        Assert.AreEqual("2026-01-02T03:04:05.0000000", page.Rows[0].Values[0]);
        Assert.IsNull(page.Rows[1].Values[0]);

        var projection = await manager.GetProjectionAsync(
            new GetResultSessionProjectionParams
            {
                SessionId = started.SessionId,
                TableId = status.Tables[0].Id,
                ViewRevision = 0,
                Scope = ResultSessionContractValues.ProjectionSelection,
                RowRanges =
                [
                    new ResultSessionRowRange { Offset = 1, Count = 1 }
                ],
                ColumnIndexes = [1],
                Offset = 0,
                Count = 1
            },
            CancellationToken.None);

        Assert.HasCount(1, projection.Columns);
        Assert.AreEqual("Value", projection.Columns[0].Name);
        Assert.HasCount(1, projection.Rows);
        Assert.AreEqual(1, projection.Rows[0].SourceIndex);
        Assert.AreEqual(20, projection.Rows[0].Values[0]);
        Assert.AreEqual(1, projection.ProjectedRows);
        Assert.IsFalse(projection.HasMore);
    }

    [TestMethod]
    public async Task SetView_SortsTypedValuesStablyAndPreservesViewOnRejectedChanges()
    {
        var table = new DataTable("Sorted");
        table.Columns.Add("Key", typeof(int));
        table.Columns.Add("Label", typeof(string));
        table.Rows.Add(2, "a");
        table.Rows.Add(1, "x");
        table.Rows.Add(2, "b");
        table.Rows.Add(1, "y");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var set = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 0,
                    Direction = ResultSessionContractValues.SortAscending
                }
            ]
        }, CancellationToken.None);

        Assert.IsTrue(set.Accepted);
        var page = await GetPageAsync(manager, sessionId, tableId, 1, 0, 10);
        CollectionAssert.AreEqual(
            new long[] { 1, 3, 0, 2 },
            page.Rows.Select(row => row.SourceIndex).ToArray());

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            GetPageAsync(manager, sessionId, tableId, 0, 0, 1));

        var unchanged = await GetPageAsync(manager, sessionId, tableId, 1, 0, 10);
        CollectionAssert.AreEqual(
            new long[] { 1, 3, 0, 2 },
            unchanged.Rows.Select(row => row.SourceIndex).ToArray());

        var multipleSorts = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 2,
            Filters = [],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 0,
                    Direction = ResultSessionContractValues.SortAscending
                },
                new ResultSessionColumnSort
                {
                    ColumnIndex = 1,
                    Direction = ResultSessionContractValues.SortDescending
                }
            ]
        }, CancellationToken.None);
        Assert.IsTrue(multipleSorts.Accepted);
        var multipleSortPage = await GetPageAsync(manager, sessionId, tableId, 2, 0, 10);
        CollectionAssert.AreEqual(
            new long[] { 3, 1, 2, 0 },
            multipleSortPage.Rows.Select(row => row.SourceIndex).ToArray());

        var staleSet = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 2,
            Filters = [],
            Sorts = []
        }, CancellationToken.None);
        Assert.IsFalse(staleSet.Accepted);
        Assert.AreEqual(2, staleSet.Revision);
    }

    [TestMethod]
    public async Task SetView_FiltersColumnsWithAndCaseSensitivityThenSortsStably()
    {
        var table = new DataTable("Events");
        table.Columns.Add("Message", typeof(string));
        table.Columns.Add("Region", typeof(string));
        table.Columns.Add("Key", typeof(int));
        table.Rows.Add("ERROR", "west", 2);
        table.Rows.Add("error", "east", 1);
        table.Rows.Add("INFO", "west", 0);
        table.Rows.Add("Error", "west", 1);
        table.Rows.Add("error", "west", 1);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var set = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters =
            [
                Filter(0, "^error$", caseSensitive: false),
                Filter(1, "^west$", caseSensitive: true)
            ],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 2,
                    Direction = ResultSessionContractValues.SortAscending
                }
            ]
        }, CancellationToken.None);

        Assert.IsTrue(set.Accepted);
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        Assert.AreEqual(ResultSessionContractValues.ViewStateReady, status.Tables[0].View?.State);
        Assert.AreEqual(3, status.Tables[0].View?.MatchedRows);
        Assert.IsTrue(status.Tables[0].View?.Filters?.All(
            filter => filter.State == ResultSessionContractValues.FilterStateValid));

        var page = await GetPageAsync(manager, sessionId, tableId, 1, 0, 10);
        Assert.AreEqual(3, page.ViewRows);
        CollectionAssert.AreEqual(
            new long[] { 3, 4, 0 },
            page.Rows.Select(row => row.SourceIndex).ToArray());

        var projection = await manager.GetProjectionAsync(
            new GetResultSessionProjectionParams
            {
                SessionId = sessionId,
                TableId = tableId,
                ViewRevision = 1,
                Scope = ResultSessionContractValues.ProjectionFiltered,
                ColumnIndexes = [0],
                Offset = 1,
                Count = 2
            },
            CancellationToken.None);
        Assert.AreEqual(3, projection.ProjectedRows);
        CollectionAssert.AreEqual(
            new long[] { 4, 0 },
            projection.Rows.Select(row => row.SourceIndex).ToArray());

        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 2,
            Filters = [Filter(0, "^ERROR$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);
        var caseSensitivePage = await GetPageAsync(manager, sessionId, tableId, 2, 0, 10);
        CollectionAssert.AreEqual(
            new long[] { 0 },
            caseSensitivePage.Rows.Select(row => row.SourceIndex).ToArray());
    }

    [TestMethod]
    public async Task SetView_InvalidRegexReportsFailedRevisionAndPreservesReadyView()
    {
        var table = new DataTable("Values");
        table.Columns.Add("Value", typeof(string));
        table.Rows.Add("keep");
        table.Rows.Add("discard");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^keep$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        var invalid = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 2,
            Filters = [Filter(0, "[", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        Assert.IsTrue(invalid.Accepted);
        Assert.AreEqual(2, invalid.Revision);
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        var view = status.Tables[0].View;
        Assert.AreEqual(2, view?.Revision);
        Assert.AreEqual(ResultSessionContractValues.ViewStateFailed, view?.State);
        Assert.IsNull(view?.MatchedRows);
        Assert.AreEqual(ResultSessionContractValues.FilterStateInvalid, view?.Filters?[0].State);
        StringAssert.Contains(view?.Filters?[0].Error?.Message, "Invalid regular expression");
        StringAssert.Contains(view?.Error?.Message, "column 0");
        Assert.AreEqual(1, view?.ReadyRevision);
        Assert.AreEqual(1, view?.ReadyMatchedRows);
        Assert.AreEqual("^keep$", view?.ReadyFilters?[0].Pattern);

        var preservedPage = await GetPageAsync(manager, sessionId, tableId, 1, 0, 10);
        CollectionAssert.AreEqual(
            new long[] { 0 },
            preservedPage.Rows.Select(row => row.SourceIndex).ToArray());
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            GetPageAsync(manager, sessionId, tableId, 2, 0, 10));
    }

    [TestMethod]
    public async Task SetView_RejectsExcessivelyLongRegex()
    {
        var table = new DataTable("Text");
        table.Columns.Add("Value", typeof(string));
        table.Rows.Add("value");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var set = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, new string('a', 4_097), caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        Assert.IsTrue(set.Accepted);
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        Assert.AreEqual(ResultSessionContractValues.ViewStateFailed, status.Tables[0].View?.State);
        StringAssert.Contains(status.Tables[0].View?.Filters?[0].Error?.Message, "at most 4096");
    }

    [TestMethod]
    public async Task SetView_PathologicalRegexTimesOutWithDiagnostic()
    {
        var table = new DataTable("Text");
        table.Columns.Add("Value", typeof(string));
        table.Rows.Add(new string('a', 50_000) + "!");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        var stopwatch = Stopwatch.StartNew();

        var set = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^(a+)+$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        stopwatch.Stop();
        Assert.IsTrue(set.Accepted);
        Assert.IsLessThan(TimeSpan.FromSeconds(5), stopwatch.Elapsed);
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        Assert.AreEqual(ResultSessionContractValues.ViewStateFailed, status.Tables[0].View?.State);
        StringAssert.Contains(status.Tables[0].View?.Error?.Message, "timed out");
        StringAssert.Contains(status.Tables[0].View?.Filters?[0].Error?.Message, "100 ms");
    }

    [TestMethod]
    public async Task SetView_SupersedingRevisionCancelsStaleEvaluation()
    {
        var table = new DataTable("Text");
        table.Columns.Add("Value", typeof(string));
        for (var index = 0; index < 100_000; index++)
            table.Rows.Add($"{index:D6}-{new string('x', 64)}");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var stale = manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "not-present$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);
        var current = manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 2,
            Filters = [],
            Sorts = []
        }, CancellationToken.None);

        var results = await Task.WhenAll(stale, current);
        Assert.IsTrue(results.All(result => result.Accepted));
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        Assert.AreEqual(2, status.Tables[0].View?.Revision);
        Assert.AreEqual(ResultSessionContractValues.ViewStateReady, status.Tables[0].View?.State);
        Assert.AreEqual(100_000, status.Tables[0].View?.MatchedRows);
        var page = await GetPageAsync(manager, sessionId, tableId, 2, 99_999, 1);
        Assert.AreEqual(99_999, page.Rows[0].SourceIndex);
    }

    [TestMethod]
    public async Task SetView_CallerCancellationPreservesTheReadyView()
    {
        var table = new DataTable("Text");
        table.Columns.Add("Value", typeof(string));
        for (var index = 0; index < 100_000; index++)
            table.Rows.Add($"{index:D6}-{new string('x', 64)}");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        using var cancellation = new CancellationTokenSource();

        var set = manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "not-present$", caseSensitive: true)],
            Sorts = []
        }, cancellation.Token);
        cancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => set);
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = sessionId });
        Assert.AreEqual(1, status.Tables[0].View?.Revision);
        Assert.AreEqual(ResultSessionContractValues.ViewStateFailed, status.Tables[0].View?.State);
        StringAssert.Contains(status.Tables[0].View?.Error?.Message, "cancelled");
        var original = await GetPageAsync(manager, sessionId, tableId, 0, 99_999, 1);
        Assert.AreEqual(99_999, original.Rows[0].SourceIndex);
    }

    [TestMethod]
    public async Task HundredThousandRows_LocalFilteringRemainsBounded()
    {
        var table = new DataTable("Numbers");
        table.Columns.Add("Value", typeof(int));
        for (var index = 0; index < 100_000; index++)
            table.Rows.Add(index);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        var stopwatch = Stopwatch.StartNew();

        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^9999[0-9]$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        stopwatch.Stop();
        Assert.IsLessThan(TimeSpan.FromSeconds(5), stopwatch.Elapsed);
        var page = await GetPageAsync(manager, sessionId, tableId, 1, 0, 1_000);
        Assert.AreEqual(10, page.ViewRows);
        Assert.HasCount(10, page.Rows);
        Assert.AreEqual(99_990, page.Rows[0].SourceIndex);
        Assert.AreEqual(99_999, page.Rows[^1].SourceIndex);
    }

    [TestMethod]
    public async Task Page_ValidatesBoundariesAndAllowsTheEndOffset()
    {
        var table = IntTable(3);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var finalPage = await GetPageAsync(manager, sessionId, tableId, 0, 3, 1000);
        Assert.HasCount(0, finalPage.Rows);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            GetPageAsync(manager, sessionId, tableId, 0, 4, 1));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            GetPageAsync(manager, sessionId, tableId, 0, 0, 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            GetPageAsync(manager, sessionId, tableId, 0, 0, 1001));

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            manager.GetProjectionAsync(new GetResultSessionProjectionParams
            {
                SessionId = sessionId,
                TableId = tableId,
                ViewRevision = 0,
                Scope = ResultSessionContractValues.ProjectionAll,
                ColumnIndexes = [0],
                Offset = 0,
                Count = ResultSessionProtocol.MaxProjectionPageSize + 1
            }, CancellationToken.None));
    }

    [TestMethod]
    public async Task Cancellation_ProducesTerminalCancelledStatusWithDiagnostic()
    {
        var queryManager = new StubQueryManager(async (_, cancellationToken) =>
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        });
        using var manager = new ResultSessionManager(queryManager);
        var started = await manager.StartAsync(NewStart());

        var cancelled = await manager.CancelAsync(
            new CancelResultSessionOperationParams { OperationId = started.OperationId });

        Assert.IsTrue(cancelled.Accepted);
        var status = await WaitForTerminalAsync(manager, started.SessionId);
        Assert.AreEqual(ResultSessionContractValues.StateCancelled, status.State);
        StringAssert.Contains(status.Error?.Message, "cancelled");
        var again = await manager.CancelAsync(
            new CancelResultSessionOperationParams { OperationId = started.OperationId });
        Assert.IsFalse(again.Accepted);
    }

    [TestMethod]
    public async Task ExecutionErrors_ProduceTerminalFailedStatusWithDiagnostic()
    {
        var diagnostic = new Diagnostic("TEST001", "query failed")
            .WithDescription("failure details");
        var queryManager = new StubQueryManager((query, _) => Task.FromResult(new RunResult
        {
            Query = query,
            Error = diagnostic
        }));
        using var manager = new ResultSessionManager(queryManager);
        var started = await manager.StartAsync(NewStart());

        var status = await WaitForTerminalAsync(manager, started.SessionId);

        Assert.AreEqual(ResultSessionContractValues.StateFailed, status.State);
        Assert.AreEqual("query failed", status.Error?.Message);
        Assert.AreEqual("failure details", status.Error?.Details);
        Assert.HasCount(0, status.Tables);
    }

    [TestMethod]
    public async Task ConnectionDirective_PreservesTheEffectiveConnectionForTheClient()
    {
        var queryManager = new StubQueryManager((query, _) => Task.FromResult(new RunResult
        {
            Query = query,
            Connection = "https://example.kusto.windows.net;Fed=true",
            Cluster = "example.kusto.windows.net",
            Database = "Other"
        }));
        using var manager = new ResultSessionManager(queryManager);
        var started = await manager.StartAsync(NewStart());

        var status = await WaitForTerminalAsync(manager, started.SessionId);

        Assert.AreEqual("https://example.kusto.windows.net;Fed=true", status.Connection);
        Assert.AreEqual("example.kusto.windows.net", status.Provenance?.Cluster);
        Assert.AreEqual("Other", status.Provenance?.Database);
    }

    [TestMethod]
    public async Task UnexpectedExecutionErrors_AreCapturedAsFailedStatus()
    {
        var queryManager = new StubQueryManager((_, _) =>
            Task.FromException<RunResult>(new InvalidOperationException("transport failed")));
        using var manager = new ResultSessionManager(queryManager);
        var started = await manager.StartAsync(NewStart());

        var status = await WaitForTerminalAsync(manager, started.SessionId);

        Assert.AreEqual(ResultSessionContractValues.StateFailed, status.State);
        Assert.AreEqual("transport failed", status.Error?.Message);
        Assert.AreEqual(
            typeof(InvalidOperationException).FullName,
            status.Error?.Details);
    }

    [TestMethod]
    public async Task Dispose_ReleasesTablesAndIsIdempotent()
    {
        using var manager = CompletedManager(IntTable(2));
        var started = await manager.StartAsync(NewStart());
        await WaitForTerminalAsync(manager, started.SessionId);

        var disposed = await manager.DisposeAsync(
            new DisposeResultSessionParams { SessionId = started.SessionId });
        var disposedAgain = await manager.DisposeAsync(
            new DisposeResultSessionParams { SessionId = started.SessionId });
        var status = await manager.GetStatusAsync(
            new GetResultSessionStatusParams { SessionId = started.SessionId });

        Assert.IsTrue(disposed.Disposed);
        Assert.IsFalse(disposedAgain.Disposed);
        Assert.AreEqual(ResultSessionContractValues.StateDisposed, status.State);
        Assert.HasCount(0, status.Tables);
    }

    [TestMethod]
    public async Task HundredThousandRows_PageResponseRemainsBounded()
    {
        using var manager = CompletedManager(IntTable(100_000));
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var page = await GetPageAsync(manager, sessionId, tableId, 0, 99_000, 1_000);

        Assert.HasCount(ResultSessionProtocol.MaxPageSize, page.Rows);
        Assert.AreEqual(100_000, page.ViewRows);
        Assert.AreEqual(99_000, page.Rows[0].SourceIndex);
        Assert.AreEqual(99_999, page.Rows[^1].SourceIndex);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            GetPageAsync(manager, sessionId, tableId, 0, 0, 1_001));
    }

    [TestMethod]
    public async Task Page_PreservesPrecisionSensitiveNumbersAsStrings()
    {
        var table = new DataTable("Precise");
        table.Columns.Add("LongValue", typeof(long));
        table.Columns.Add("DecimalValue", typeof(decimal));
        table.Columns.Add("RealValue", typeof(double));
        table.Rows.Add(long.MaxValue, 1234567890123456789.123456789m, 1e20);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var page = await GetPageAsync(manager, sessionId, tableId, 0, 0, 1);

        Assert.AreEqual("9223372036854775807", page.Rows[0].Values[0]);
        Assert.AreEqual("1234567890123456789.123456789", page.Rows[0].Values[1]);
        Assert.AreEqual("1E+20", page.Rows[0].Values[2]);

        var filtered = await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(2, "^1E\\+20$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);
        Assert.IsTrue(filtered.Accepted);
        var filteredPage = await GetPageAsync(manager, sessionId, tableId, 1, 0, 1);
        Assert.HasCount(1, filteredPage.Rows);
    }

    [TestMethod]
    public async Task Continuation_ExactSnapshotPreservesTypesEscapingAndRequestedColumnOrder()
    {
        var table = new DataTable("Typed");
        table.Columns.Add("plain", typeof(int));
        table.Columns.Add("display name", typeof(string));
        table.Columns.Add("enabled", typeof(bool));
        table.Columns.Add("tiny", typeof(byte));
        table.Columns.Add("payload", typeof(object));
        table.Rows.Add(7, "O'Reilly\n東京", true, byte.MaxValue, """{"value":"safe"}""");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [4, 1, 3, 2],
            null,
            CancellationToken.None);

        Assert.IsNotNull(result.SnapshotQuery);
        StringAssert.StartsWith(result.SnapshotQuery, "// Exact snapshot");
        StringAssert.Contains(
            result.SnapshotQuery,
            "let LocalResult = datatable (payload: dynamic, ['display name']: string, tiny: bool, enabled: bool)");
        StringAssert.Contains(result.SnapshotQuery, """dynamic({"value":"safe"})""");
        StringAssert.Contains(result.SnapshotQuery, "true, true");
        StringAssert.EndsWith(result.SnapshotQuery, "];\nLocalResult");
        Assert.AreEqual(
            Encoding.UTF8.GetByteCount(result.SnapshotQuery),
            result.SnapshotTextBytes);
        Assert.AreEqual(1, result.ProjectedRows);
        Assert.IsNull(result.LiveRerunQuery);
    }

    [TestMethod]
    public async Task Continuation_UsesReadyFilteredSortedOrderAndMapsSelectionRanges()
    {
        var table = new DataTable("Ordered");
        table.Columns.Add("Key", typeof(int));
        table.Columns.Add("Label", typeof(string));
        table.Rows.Add(2, "keep-a");
        table.Rows.Add(1, "drop");
        table.Rows.Add(3, "keep-b");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(1, "^keep", caseSensitive: true)],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 0,
                    Direction = ResultSessionContractValues.SortDescending
                }
            ]
        }, CancellationToken.None);

        var filtered = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [1, 0]);
        Assert.IsNotNull(filtered.SnapshotQuery);
        Assert.IsTrue(
            filtered.SnapshotQuery.IndexOf("keep-b", StringComparison.Ordinal)
                < filtered.SnapshotQuery.IndexOf("keep-a", StringComparison.Ordinal),
            filtered.SnapshotQuery);

        var selection = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionSelection,
            [1, 0],
            [new ResultSessionRowRange { Offset = 1, Count = 1 }]);
        Assert.IsNotNull(selection.SnapshotQuery);
        StringAssert.Contains(selection.SnapshotQuery, "keep-a");
        Assert.IsFalse(selection.SnapshotQuery.Contains("keep-b", StringComparison.Ordinal));
        Assert.AreEqual(1, selection.ProjectedRows);
    }

    [TestMethod]
    public async Task Continuation_EmptySnapshotIsValidTypedDatatableKql()
    {
        var table = new DataTable("Empty");
        table.Columns.Add("Count", typeof(long));
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);

        Assert.IsNotNull(result.SnapshotQuery);
        StringAssert.Contains(result.SnapshotQuery, "datatable (Count: long) [\n\n];");
        StringAssert.EndsWith(result.SnapshotQuery, "LocalResult");
        Assert.AreEqual(0, result.ProjectedRows);
        Assert.AreEqual(
            ResultSessionProtocol.ScopedQueryTextBudgetBytes,
            result.QueryTextBudgetBytes);
    }

    [TestMethod]
    public async Task Continuation_UsesUtf8MonitorAndAdxBudgets()
    {
        var table = new DataTable("Unicode");
        table.Columns.Add("Text", typeof(string));
        table.Rows.Add(new string('é', 35_000));

        using var monitorManager = CompletedManager(table.Copy());
        var monitorStart = await StartAndGetTableAsync(
            monitorManager,
            NewStart(cluster: "https://ade.loganalytics.io/subscriptions/example"));
        var monitor = await CreateContinuationAsync(
            monitorManager,
            monitorStart.SessionId,
            monitorStart.TableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);
        Assert.AreEqual(ResultSessionProtocol.ScopedQueryTextBudgetBytes, monitor.QueryTextBudgetBytes);
        Assert.IsNull(monitor.SnapshotQuery);
        Assert.IsGreaterThan(monitor.QueryTextBudgetBytes, monitor.SnapshotTextBytes);

        using var adxManager = CompletedManager(table.Copy());
        var adxStart = await StartAndGetTableAsync(
            adxManager,
            NewStart(cluster: "https://sample.westeurope.kusto.windows.net"));
        var adx = await CreateContinuationAsync(
            adxManager,
            adxStart.SessionId,
            adxStart.TableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);
        Assert.AreEqual(ResultSessionProtocol.NativeAdxQueryTextBudgetBytes, adx.QueryTextBudgetBytes);
        Assert.IsNotNull(adx.SnapshotQuery);
        Assert.AreEqual(Encoding.UTF8.GetByteCount(adx.SnapshotQuery), adx.SnapshotTextBytes);
        Assert.IsGreaterThan(ResultSessionProtocol.ScopedQueryTextBudgetBytes, adx.SnapshotTextBytes);
    }

    [TestMethod]
    public async Task Continuation_OversizedSelectionDoesNotOfferLiveRerun()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Text", typeof(string));
        table.Rows.Add(new string('x', 70_000));
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            0,
            ResultSessionContractValues.ProjectionSelection,
            [0],
            [new ResultSessionRowRange { Offset = 0, Count = 1 }]);

        Assert.IsNull(result.SnapshotQuery);
        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "arbitrary row selection");
    }

    [TestMethod]
    public async Task Continuation_OversizedFilteredSnapshotOffersSupportedLiveRerun()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Message", typeof(string));
        table.Columns.Add("Code", typeof(int));
        for (var index = 0; index < 1_000; index++)
            table.Rows.Add($"keep-{index:D4}-{new string('x', 80)}", index);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(
            manager,
            NewStart("LargeSource | take 1000 ;;; \r\n"));
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^keep\\-[0-9]+", caseSensitive: true)],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 1,
                    Direction = ResultSessionContractValues.SortDescending
                }
            ]
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [1, 0]);

        Assert.IsNull(result.SnapshotQuery);
        Assert.IsNotNull(result.LiveRerunQuery);
        StringAssert.StartsWith(result.LiveRerunQuery, "#connect cluster(");
        StringAssert.Contains(result.LiveRerunQuery, "// LIVE RERUN:");
        StringAssert.Contains(
            result.LiveRerunQuery,
            "LargeSource | take 1000\n| where tostring(Message) matches regex '^keep\\\\-[0-9]+'");
        StringAssert.Contains(result.LiveRerunQuery, "\n| order by Code desc\n| project");
        StringAssert.EndsWith(result.LiveRerunQuery, "| project Code, Message");
        Assert.IsNull(result.LiveRerunUnavailableReason);
        Assert.AreEqual(
            Encoding.UTF8.GetByteCount(result.LiveRerunQuery),
            result.LiveRerunTextBytes);
    }

    [TestMethod]
    public async Task Continuation_AllScopeDoesNotReplayReadyFiltersOrSorts()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Message", typeof(string));
        table.Columns.Add("Code", typeof(int));
        for (var index = 0; index < 1_000; index++)
            table.Rows.Add($"keep-{index:D4}-{new string('x', 80)}", index);
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(
            manager,
            NewStart("LargeSource | take 1000"));
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^keep-0", caseSensitive: true)],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 1,
                    Direction = ResultSessionContractValues.SortDescending
                }
            ]
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionAll,
            [0]);

        Assert.IsNull(result.SnapshotQuery);
        Assert.IsNotNull(result.LiveRerunQuery);
        Assert.IsFalse(result.LiveRerunQuery.Contains("| where", StringComparison.Ordinal));
        Assert.IsFalse(result.LiveRerunQuery.Contains("| order by", StringComparison.Ordinal));
        StringAssert.EndsWith(result.LiveRerunQuery, "| project Message");
    }

    [TestMethod]
    public async Task Continuation_UnsupportedRegexNamesColumnAndPreventsLiveRerun()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Message", typeof(string));
        for (var index = 0; index < 1_000; index++)
            table.Rows.Add($"keep-{new string('x', 80)}");
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^(?=keep)", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [0]);

        Assert.IsNull(result.SnapshotQuery);
        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Message'");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "beginning with '(?'");
    }

    [TestMethod]
    public async Task Continuation_DollarRegexAnchorCannotBeReplayed()
    {
        var table = LargeTextTable();
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "x*$", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [0]);

        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "'$' anchor");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Text'");
    }

    [TestMethod]
    public async Task Continuation_RegexReplayRejectsLetterEscapesAndCountedRepetitions()
    {
        var cases = new[]
        {
            (Pattern: "^row-\\w+", Reason: "letter escape '\\w'"),
            (Pattern: "^row-[0-9]{4}", Reason: "counted-repetition")
        };
        foreach (var testCase in cases)
        {
            using var manager = CompletedManager(LargeTextTable());
            var (sessionId, tableId) = await StartAndGetTableAsync(manager);
            await manager.SetViewAsync(new SetResultSessionViewParams
            {
                SessionId = sessionId,
                TableId = tableId,
                Revision = 1,
                Filters = [Filter(0, testCase.Pattern, caseSensitive: true)],
                Sorts = []
            }, CancellationToken.None);

            var result = await CreateContinuationAsync(
                manager,
                sessionId,
                tableId,
                1,
                ResultSessionContractValues.ProjectionFiltered,
                [0]);

            Assert.IsNull(result.LiveRerunQuery);
            StringAssert.Contains(result.LiveRerunUnavailableReason, testCase.Reason);
            StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Text'");
        }
    }

    [TestMethod]
    public async Task Continuation_RegexReplayRejectsCaseInsensitiveFilter()
    {
        using var manager = CompletedManager(LargeTextTable());
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^ROW-", caseSensitive: false)],
            Sorts = []
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [0]);

        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "case-insensitive");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Text'");
    }

    [TestMethod]
    public async Task Continuation_LiveRerunBindsEffectiveAdxAndScopedConnections()
    {
        var cases = new[]
        {
            (
                Cluster: "https://sample.westeurope.kusto.windows.net",
                Database: "db'quoted",
                TextLength: ResultSessionProtocol.NativeAdxQueryTextBudgetBytes + 1_024),
            (
                Cluster: "https://ade.loganalytics.io/subscriptions/o'reilly/resource",
                Database: "workspace'quoted",
                TextLength: ResultSessionProtocol.ScopedQueryTextBudgetBytes + 1_024)
        };
        foreach (var testCase in cases)
        {
            var table = new DataTable("Large");
            table.Columns.Add("Text", typeof(string));
            table.Rows.Add(new string('x', testCase.TextLength));
            using var manager = CompletedManager(table);
            var (sessionId, tableId) = await StartAndGetTableAsync(
                manager,
                NewStart(
                    "LargeSource",
                    cluster: testCase.Cluster,
                    database: testCase.Database));

            var result = await CreateContinuationAsync(
                manager,
                sessionId,
                tableId,
                0,
                ResultSessionContractValues.ProjectionAll,
                [0]);

            Assert.IsNotNull(result.LiveRerunQuery);
            var directiveText = result.LiveRerunQuery.Split('\n')[0].TrimEnd('\r');
            StringAssert.Contains(
                directiveText,
                KustoGenerator.GetStringLiteral(testCase.Cluster));
            Assert.IsTrue(ClientDirective.TryParse(directiveText, out var directive));
            Assert.IsTrue(directive.TryGetConnectionInfo(
                out var connection,
                out var cluster,
                out var database));
            Assert.IsNull(connection);
            var expectedCluster = testCase.Cluster.Contains(
                "ade.loganalytics.io",
                StringComparison.OrdinalIgnoreCase)
                ? testCase.Cluster
                : new Uri(testCase.Cluster).Host;
            Assert.AreEqual(expectedCluster, cluster);
            Assert.AreEqual(testCase.Database, database);
            Assert.IsFalse(result.LiveRerunQuery.Contains("Data Source=", StringComparison.Ordinal));
        }
    }

    [TestMethod]
    public async Task Continuation_TerminalSemicolonBeforeTrailingCommentCannotBeReplayed()
    {
        foreach (var query in new[]
        {
            "LargeSource; // trailing comment",
            "LargeSource; /* trailing block comment */",
            "LargeSource; // first comment\n// second comment",
            "LargeSource; /* first comment */\n// second comment",
            "LargeSource; // first comment\n/* second comment */"
        })
        {
            using var manager = CompletedManager(LargeTextTable());
            var (sessionId, tableId) = await StartAndGetTableAsync(
                manager,
                NewStart(query));

            var result = await CreateContinuationAsync(
                manager,
                sessionId,
                tableId,
                0,
                ResultSessionContractValues.ProjectionAll,
                [0]);

            Assert.IsNull(result.LiveRerunQuery);
            StringAssert.Contains(
                result.LiveRerunUnavailableReason,
                "trailing comment trivia after a terminal semicolon");
        }
    }

    [TestMethod]
    public async Task Continuation_NonStringFilterCannotBeReplayed()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Number", typeof(int));
        table.Columns.Add("Payload", typeof(string));
        for (var index = 0; index < 1_000; index++)
            table.Rows.Add(index, new string('x', 80));
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [Filter(0, "^\\d+", caseSensitive: true)],
            Sorts = []
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [1]);

        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Number'");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "type 'int'");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "only string-column");
    }

    [TestMethod]
    public async Task Continuation_StringSortCannotClaimExactLiveReplay()
    {
        var table = LargeTextTable();
        using var manager = CompletedManager(table);
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);
        await manager.SetViewAsync(new SetResultSessionViewParams
        {
            SessionId = sessionId,
            TableId = tableId,
            Revision = 1,
            Filters = [],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 0,
                    Direction = ResultSessionContractValues.SortAscending
                }
            ]
        }, CancellationToken.None);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionFiltered,
            [0]);

        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "column 'Text'");
        StringAssert.Contains(result.LiveRerunUnavailableReason, "local ordering");
    }

    [TestMethod]
    public async Task Continuation_DirectiveExecutionContextMustMatchSessionBaseline()
    {
        var readOnlyOptions = ImmutableDictionary<string, string>.Empty.Add(
            ClientRequestProperties.OptionRequestReadOnly,
            "true");
        using var baselineManager = new ResultSessionManager(new StubQueryManager((_, _) =>
            Task.FromResult(Success(new EditString("LargeSource"), LargeTextTable()) with
            {
                QueryOptions = readOnlyOptions,
                QueryParameters = ImmutableDictionary<string, string>.Empty
            })));
        var baselineSession = await StartAndGetTableAsync(
            baselineManager,
            NewStart("LargeSource", isReadOnly: true));
        var baselineResult = await CreateContinuationAsync(
            baselineManager,
            baselineSession.SessionId,
            baselineSession.TableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);
        Assert.IsNotNull(baselineResult.LiveRerunQuery);

        using var parameterManager = new ResultSessionManager(new StubQueryManager((_, _) =>
            Task.FromResult(Success(new EditString("LargeSource"), LargeTextTable()) with
            {
                QueryOptions = readOnlyOptions,
                QueryParameters = ImmutableDictionary<string, string>.Empty.Add(
                    "threshold",
                    "long(1)")
            })));
        var parameterSession = await StartAndGetTableAsync(
            parameterManager,
            NewStart("#qp threshold=long(1)\nLargeSource", isReadOnly: true));
        var parameterResult = await CreateContinuationAsync(
            parameterManager,
            parameterSession.SessionId,
            parameterSession.TableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);
        Assert.IsNull(parameterResult.LiveRerunQuery);
        StringAssert.Contains(parameterResult.LiveRerunUnavailableReason, "query parameters");

        using var optionManager = new ResultSessionManager(new StubQueryManager((_, _) =>
            Task.FromResult(Success(new EditString("LargeSource"), LargeTextTable()) with
            {
                QueryOptions = readOnlyOptions.Add("notruncation", "true"),
                QueryParameters = ImmutableDictionary<string, string>.Empty
            })));
        var optionSession = await StartAndGetTableAsync(
            optionManager,
            NewStart("#crp notruncation=true\nLargeSource", isReadOnly: true));
        var optionResult = await CreateContinuationAsync(
            optionManager,
            optionSession.SessionId,
            optionSession.TableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);
        Assert.IsNull(optionResult.LiveRerunQuery);
        StringAssert.Contains(optionResult.LiveRerunUnavailableReason, "altered query options");
    }

    [TestMethod]
    public async Task QueryManager_RetainsDirectiveAlteredExecutionContext()
    {
        var connection = new CapturingConnection();
        var queryManager = new QueryManager(
            new SingleConnectionManager(connection),
            null!,
            null!,
            null!);
        var baselineOptions = ImmutableDictionary<string, string>.Empty.Add(
            ClientRequestProperties.OptionRequestReadOnly,
            "true");

        var result = await queryManager.RunQueryAsync(
            new EditString(
                "#qp threshold=long(1)\n#crp notruncation=true\nLargeSource"),
            "cluster",
            "database",
            baselineOptions,
            ImmutableDictionary<string, string>.Empty,
            clientRequestId: null,
            hardMaxRows: null,
            CancellationToken.None);

        Assert.AreEqual("LargeSource", result.Query.ToString());
        Assert.AreEqual("long(1)", result.QueryParameters?["threshold"]);
        Assert.AreEqual("true", result.QueryOptions?["notruncation"]);
        Assert.AreEqual(
            "true",
            result.QueryOptions?[ClientRequestProperties.OptionRequestReadOnly]);
        Assert.AreSame(connection.Options, result.QueryOptions);
        Assert.AreSame(connection.Parameters, result.QueryParameters);
    }

    [TestMethod]
    public async Task Continuation_MultipleTablesMakeOversizedLiveRerunAmbiguous()
    {
        var large = new DataTable("Large");
        large.Columns.Add("Text", typeof(string));
        large.Rows.Add(new string('x', 70_000));
        using var manager = CompletedManager(large, IntTable(1));
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        var result = await CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0]);

        Assert.IsNull(result.LiveRerunQuery);
        StringAssert.Contains(result.LiveRerunUnavailableReason, "multiple result tables");
    }

    [TestMethod]
    public async Task Continuation_RejectsStaleRevisionAndHonorsCancellation()
    {
        using var manager = CompletedManager(IntTable(2));
        var (sessionId, tableId) = await StartAndGetTableAsync(manager);

        await Assert.ThrowsAsync<InvalidOperationException>(() => CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            1,
            ResultSessionContractValues.ProjectionAll,
            [0]));

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => CreateContinuationAsync(
            manager,
            sessionId,
            tableId,
            0,
            ResultSessionContractValues.ProjectionAll,
            [0],
            cancellationToken: cancellation.Token));
    }

    [TestMethod]
    public async Task ConcurrentStarts_DoNotExceedTheSessionLimit()
    {
        var queryGate = new TaskCompletionSource<RunResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var queryManager = new StubQueryManager((_, cancellationToken) =>
            queryGate.Task.WaitAsync(cancellationToken));
        using var manager = new ResultSessionManager(queryManager);

        var starts = Enumerable.Range(0, 100).Select(_ => Task.Run(async () =>
        {
            try
            {
                await manager.StartAsync(NewStart());
                return true;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }));
        var accepted = await Task.WhenAll(starts);

        Assert.AreEqual(64, accepted.Count(value => value));
        queryGate.SetResult(Success("print Value=1", IntTable(1)));
    }

    private static ResultSessionManager CompletedManager(params DataTable[] tables)
    {
        return new ResultSessionManager(new StubQueryManager((query, _) =>
            Task.FromResult(Success(query, tables))));
    }

    private static async Task<(string SessionId, string TableId)> StartAndGetTableAsync(
        ResultSessionManager manager,
        StartResultSessionParams? parameters = null)
    {
        var started = await manager.StartAsync(parameters ?? NewStart());
        var status = await WaitForTerminalAsync(manager, started.SessionId);
        Assert.AreEqual(ResultSessionContractValues.StateCompleted, status.State);
        return (started.SessionId, status.Tables[0].Id);
    }

    private static StartResultSessionParams NewStart(
        string query = "print Value=1",
        string? cluster = "cluster",
        string? database = "database",
        bool? isReadOnly = null)
    {
        return new StartResultSessionParams
        {
            ProtocolVersion = ResultSessionProtocol.Version,
            Query = query,
            Cluster = cluster,
            Database = database,
            IsReadOnly = isReadOnly,
            ClientRequestId = "request"
        };
    }

    private static ResultSessionColumnFilter Filter(
        int columnIndex,
        string pattern,
        bool caseSensitive)
    {
        return new ResultSessionColumnFilter
        {
            ColumnIndex = columnIndex,
            Pattern = pattern,
            CaseSensitive = caseSensitive
        };
    }

    private static RunResult Success(EditString query, params DataTable[] tables)
    {
        return new RunResult
        {
            Query = query,
            ExecuteResult = new ExecuteResult
            {
                Tables = tables.ToImmutableList()
            }
        };
    }

    private static DataTable IntTable(int rows)
    {
        var table = new DataTable("Numbers");
        table.Columns.Add("Value", typeof(int));
        for (var index = 0; index < rows; index++)
            table.Rows.Add(index);
        return table;
    }

    private static DataTable LargeTextTable()
    {
        var table = new DataTable("Large");
        table.Columns.Add("Text", typeof(string));
        for (var index = 0; index < 1_000; index++)
            table.Rows.Add($"row-{index:D4}-{new string('x', 80)}");
        return table;
    }

    private static Task<ResultSessionPage> GetPageAsync(
        ResultSessionManager manager,
        string sessionId,
        string tableId,
        long revision,
        long offset,
        int count)
    {
        return manager.GetPageAsync(new GetResultSessionPageParams
        {
            SessionId = sessionId,
            TableId = tableId,
            ViewRevision = revision,
            Offset = offset,
            Count = count
        }, CancellationToken.None);
    }

    private static Task<CreateResultSessionContinuationResult> CreateContinuationAsync(
        ResultSessionManager manager,
        string sessionId,
        string tableId,
        long revision,
        string scope,
        ImmutableList<int> columnIndexes,
        ImmutableList<ResultSessionRowRange>? rowRanges = null,
        CancellationToken cancellationToken = default)
    {
        return manager.CreateContinuationAsync(new CreateResultSessionContinuationParams
        {
            SessionId = sessionId,
            TableId = tableId,
            ViewRevision = revision,
            Scope = scope,
            RowRanges = rowRanges,
            ColumnIndexes = columnIndexes
        }, cancellationToken);
    }

    private static async Task<ResultSessionStatus> WaitForTerminalAsync(
        ResultSessionManager manager,
        string sessionId)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            timeout.Token.ThrowIfCancellationRequested();
            var status = await manager.GetStatusAsync(
                new GetResultSessionStatusParams { SessionId = sessionId });
            if (status.State is ResultSessionContractValues.StateCompleted
                or ResultSessionContractValues.StateCancelled
                or ResultSessionContractValues.StateFailed)
            {
                return status;
            }
            await Task.Delay(5, timeout.Token);
        }
    }

    private sealed class StubQueryManager(
        Func<EditString, CancellationToken, Task<RunResult>> run) : IQueryManager
    {
        public Task<IReadOnlyList<Diagnostic>> ValidateQueryAsync(
            string query,
            string clusterName,
            string? databaseName,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<IReadOnlyList<Diagnostic>>([]);
        }

        public Task<string?> GetQueryResultTypeAsync(
            string query,
            string clusterName,
            string? databaseName,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<string?>(null);
        }

        public Task<RunResult> RunQueryAsync(
            EditString query,
            string? clusterName,
            string? databaseName,
            ImmutableDictionary<string, string> queryOptions,
            ImmutableDictionary<string, string> queryParameters,
            string? clientRequestId,
            long? hardMaxRows,
            CancellationToken cancellationToken)
        {
            return run(query, cancellationToken);
        }
    }

    private sealed class SingleConnectionManager(IConnection connection) : IConnectionManager
    {
        public IConnection GetOrAddConnection(string connectionStrings) => connection;

        public bool TryGetConnection(
            string clusterName,
            [NotNullWhen(true)] out IConnection? result)
        {
            result = connection;
            return true;
        }
    }

    private sealed class CapturingConnection : IConnection
    {
        public string Cluster => "cluster";
        public string? Database => "database";
        public ImmutableDictionary<string, string>? Options { get; private set; }
        public ImmutableDictionary<string, string>? Parameters { get; private set; }

        public IConnection WithCluster(string clusterName) => this;

        public IConnection WithDatabase(string databaseName) => this;

        public Task<ExecuteResult> ExecuteAsync(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            string? clientRequestId = null,
            CancellationToken cancellationToken = default)
        {
            Options = options;
            Parameters = parameters;
            return Task.FromResult(new ExecuteResult());
        }

        public Task<ExecuteResult<T>> ExecuteAsync<T>(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            CancellationToken cancellationToken = default)
        {
            throw new NotSupportedException();
        }

        public Task<string> GetServerKindAsync(CancellationToken cancellationToken) =>
            Task.FromResult("Engine");
    }
}
