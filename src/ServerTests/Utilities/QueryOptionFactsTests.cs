// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using Kusto.Data.Common;
using Kusto.Vscode;

namespace Tests.Utilities;

[TestClass]
public class QueryOptionFactsTests
{
    [TestMethod]
    public void EnforceMaximumRows_ClampsLargerDirectiveValue()
    {
        var options = ImmutableDictionary<string, string>.Empty.Add(
            ClientRequestProperties.OptionTakeMaxRecords,
            "100000");

        var result = QueryOptionFacts.EnforceMaximumRows(options, 1_000);

        Assert.AreEqual("1000", result[ClientRequestProperties.OptionTakeMaxRecords]);
    }

    [TestMethod]
    public void EnforceMaximumRows_PreservesSmallerDirectiveValue()
    {
        var options = ImmutableDictionary<string, string>.Empty.Add(
            ClientRequestProperties.OptionTakeMaxRecords,
            "25");

        var result = QueryOptionFacts.EnforceMaximumRows(options, 1_000);

        Assert.AreEqual("25", result[ClientRequestProperties.OptionTakeMaxRecords]);
    }

    [TestMethod]
    public void EnforceMaximumRows_ReplacesInvalidDirectiveValue()
    {
        var options = ImmutableDictionary<string, string>.Empty.Add(
            ClientRequestProperties.OptionTakeMaxRecords,
            "unlimited");

        var result = QueryOptionFacts.EnforceMaximumRows(options, 1_000);

        Assert.AreEqual("1000", result[ClientRequestProperties.OptionTakeMaxRecords]);
    }
}
