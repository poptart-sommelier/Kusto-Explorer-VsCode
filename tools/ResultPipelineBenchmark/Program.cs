// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Data;
using System.Diagnostics;
using System.Text;
using Kusto.Vscode;
using Newtonsoft.Json;

const int RowCount = 100_000;
const int ColumnSetCount = 2;

var process = Process.GetCurrentProcess();
var report = new Dictionary<string, object?>
{
    ["runtime"] = Environment.Version.ToString(),
    ["rows"] = RowCount,
    ["columns"] = ColumnSetCount * 10
};

ForceCollection();
var startingMemory = GC.GetTotalMemory(true);

var stopwatch = Stopwatch.StartNew();
var table = CreateMixedTypeTable(RowCount);
stopwatch.Stop();
report["dataTableCreationMs"] = stopwatch.Elapsed.TotalMilliseconds;
report["dataTableRetainedBytes"] = GC.GetTotalMemory(true) - startingMemory;

var beforeConversionMemory = GC.GetTotalMemory(true);
stopwatch.Restart();
var resultTable = ResultTable.FromDataTable(table);
stopwatch.Stop();
report["resultTableConversionMs"] = stopwatch.Elapsed.TotalMilliseconds;
report["resultTableAdditionalRetainedBytes"] = GC.GetTotalMemory(true) - beforeConversionMemory;

var beforeSerializationMemory = GC.GetTotalMemory(true);
stopwatch.Restart();
var json = JsonConvert.SerializeObject(resultTable);
stopwatch.Stop();
report["jsonSerializationMs"] = stopwatch.Elapsed.TotalMilliseconds;
report["jsonUtf8Bytes"] = Encoding.UTF8.GetByteCount(json);
report["jsonAdditionalRetainedBytes"] = GC.GetTotalMemory(true) - beforeSerializationMemory;
report["workingSetBytes"] = process.WorkingSet64;

Console.WriteLine(JsonConvert.SerializeObject(report, Formatting.Indented));
GC.KeepAlive(table);
GC.KeepAlive(resultTable);
GC.KeepAlive(json);

static DataTable CreateMixedTypeTable(int rowCount)
{
    var table = new DataTable("Baseline");
    for (var set = 0; set < ColumnSetCount; set++)
    {
        table.Columns.Add($"Text{set}", typeof(string));
        table.Columns.Add($"Integer{set}", typeof(int));
        table.Columns.Add($"Long{set}", typeof(long));
        table.Columns.Add($"Real{set}", typeof(double));
        table.Columns.Add($"Decimal{set}", typeof(decimal));
        table.Columns.Add($"Boolean{set}", typeof(bool));
        table.Columns.Add($"Timestamp{set}", typeof(DateTime));
        table.Columns.Add($"Duration{set}", typeof(TimeSpan));
        table.Columns.Add($"Identifier{set}", typeof(Guid));
        table.Columns.Add($"Dynamic{set}", typeof(object));
    }

    var timestamp = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    for (var index = 0; index < rowCount; index++)
    {
        var values = new object[ColumnSetCount * 10];
        for (var set = 0; set < ColumnSetCount; set++)
        {
            var offset = set * 10;
            values[offset] = index % 17 == 0 ? DBNull.Value : $"row-{index:D6}-set-{set}";
            values[offset + 1] = index;
            values[offset + 2] = (long)index * 10_000;
            values[offset + 3] = index / 3.0;
            values[offset + 4] = index / 7.0m;
            values[offset + 5] = index % 2 == 0;
            values[offset + 6] = timestamp.AddSeconds(index);
            values[offset + 7] = TimeSpan.FromMilliseconds(index * 10L);
            values[offset + 8] = CreateGuid(index, set);
            values[offset + 9] = $"{{\"index\":{index},\"set\":{set},\"category\":\"group-{index % 25}\"}}";
        }
        table.Rows.Add(values);
    }

    return table;
}

static Guid CreateGuid(int index, int set)
{
    return new Guid(index, (short)set, (short)(index % short.MaxValue), 0, 1, 2, 3, 4, 5, 6, 7);
}

static void ForceCollection()
{
    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
}
