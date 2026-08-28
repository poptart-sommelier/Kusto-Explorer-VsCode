// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using Kusto.Vscode;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Reflection;

namespace Tests.Utilities;

[TestClass]
public class ResultSessionContractsTests
{
    [TestMethod]
    public void Protocol_UsesStableVersionedMethodNames()
    {
        var constants = typeof(ResultSessionProtocol)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .ToDictionary(field => field.Name, field => field.GetRawConstantValue());

        Assert.AreEqual(1, constants[nameof(ResultSessionProtocol.Version)]);
        Assert.AreEqual(1_000, constants[nameof(ResultSessionProtocol.MaxPageSize)]);
        Assert.AreEqual(1_000, constants[nameof(ResultSessionProtocol.MaxProjectionPageSize)]);
        Assert.AreEqual("kusto/startResultSession", constants[nameof(ResultSessionProtocol.StartMethod)]);
        Assert.AreEqual("kusto/cancelResultSessionOperation", constants[nameof(ResultSessionProtocol.CancelMethod)]);
        Assert.AreEqual("kusto/getResultSessionStatus", constants[nameof(ResultSessionProtocol.StatusMethod)]);
        Assert.AreEqual("kusto/setResultSessionView", constants[nameof(ResultSessionProtocol.SetViewMethod)]);
        Assert.AreEqual("kusto/getResultSessionPage", constants[nameof(ResultSessionProtocol.PageMethod)]);
        Assert.AreEqual("kusto/getResultSessionProjection", constants[nameof(ResultSessionProtocol.ProjectionMethod)]);
        Assert.AreEqual("kusto/disposeResultSession", constants[nameof(ResultSessionProtocol.DisposeMethod)]);
    }

    [TestMethod]
    public void Page_SerializesWithClientContractPropertyNames()
    {
        var page = new ResultSessionPage
        {
            ProtocolVersion = ResultSessionProtocol.Version,
            SessionId = "session-1",
            TableId = "primary",
            ViewRevision = 4,
            Offset = 200,
            ViewRows = 100_000,
            Rows =
            [
                new ResultSessionRow
                {
                    SourceIndex = 412,
                    Values = ImmutableList.Create<object?>("WA", 42L, null)
                }
            ]
        };

        var json = JObject.Parse(JsonConvert.SerializeObject(page));

        Assert.AreEqual(1, json["protocolVersion"]?.Value<int>());
        Assert.AreEqual("session-1", json["sessionId"]?.Value<string>());
        Assert.AreEqual("primary", json["tableId"]?.Value<string>());
        Assert.AreEqual(4, json["viewRevision"]?.Value<long>());
        Assert.AreEqual(200, json["offset"]?.Value<long>());
        Assert.AreEqual(100_000, json["viewRows"]?.Value<long>());
        Assert.AreEqual(412, json["rows"]?[0]?["sourceIndex"]?.Value<long>());
    }

    [TestMethod]
    public void ViewContract_RepresentsMultipleAndFilters()
    {
        var view = new SetResultSessionViewParams
        {
            SessionId = "session-1",
            TableId = "primary",
            Revision = 8,
            Filters =
            [
                new ResultSessionColumnFilter
                {
                    ColumnIndex = 0,
                    Pattern = "^ERROR",
                    CaseSensitive = false
                },
                new ResultSessionColumnFilter
                {
                    ColumnIndex = 3,
                    Pattern = "timeout$",
                    CaseSensitive = true
                }
            ],
            Sorts =
            [
                new ResultSessionColumnSort
                {
                    ColumnIndex = 1,
                    Direction = "descending"
                }
            ]
        };

        Assert.HasCount(2, view.Filters);
        Assert.AreEqual(8, view.Revision);
    }

    [TestMethod]
    public void ViewStatus_AttributesInvalidRegexToColumn()
    {
        var status = new ResultSessionViewStatus
        {
            Revision = 9,
            State = ResultSessionContractValues.ViewStateFailed,
            Filters =
            [
                new ResultSessionColumnFilterStatus
                {
                    ColumnIndex = 3,
                    State = ResultSessionContractValues.FilterStateInvalid,
                    Error = new ResultSessionDiagnostic
                    {
                        Message = "Unterminated character class"
                    }
                }
            ]
        };

        Assert.AreEqual(3, status.Filters[0].ColumnIndex);
        Assert.AreEqual("invalid", status.Filters[0].State);
    }
}
