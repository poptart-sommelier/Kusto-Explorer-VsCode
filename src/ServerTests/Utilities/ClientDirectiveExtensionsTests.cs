// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language.Editor;
using Kusto.Vscode;
using System.Collections.Immutable;

namespace Tests.Utilities;

[TestClass]
public class ClientDirectiveExtensionsTests
{
    private const string LogAnalyticsUri =
        "https://ade.loganalytics.io/subscriptions/sub/resourcegroups/rg/providers/microsoft.operationalinsights/workspaces/ws";

    #region TryGetConnectionInfo - Database Directive Tests

    [TestMethod]
    public void TryGetConnectionInfo_DatabaseDirective_TwoArguments_ReturnsClusterAndDatabase()
    {
        // #database mycluster mydb
        var parsed = ClientDirective.TryParse("#database mycluster mydb", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster", cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_DatabaseDirective_SingleArgument_HostAndPath_ReturnsClusterAndDatabase()
    {
        // #database "mycluster/mydb"
        var parsed = ClientDirective.TryParse("#database \"mycluster/mydb\"", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster", cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_DatabaseDirective_SingleArgument_HostOnly_ReturnsDatabaseOnly()
    {
        // #database mydb - just a database name without cluster
        var parsed = ClientDirective.TryParse("#database mydb", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.IsNull(cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_DatabaseDirective_NoArguments_ReturnsFalse()
    {
        // #database with no arguments
        var parsed = ClientDirective.TryParse("#database", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsFalse(result);
        Assert.IsNull(connection);
        Assert.IsNull(cluster);
        Assert.IsNull(database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_DatabaseDirective_FullUrl_ReturnsClusterAndDatabase()
    {
        // #database "https://mycluster.kusto.windows.net/mydb"
        var parsed = ClientDirective.TryParse("#database \"https://mycluster.kusto.windows.net/mydb\"", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", cluster);
        Assert.AreEqual("mydb", database);
    }

    #endregion

    #region TryGetConnectionInfo - Connect Directive Tests

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_ClusterSyntax_ReturnsClusterAndDatabase()
    {
        // #connect cluster("mycluster").database("mydb")
        var parsed = ClientDirective.TryParse("#connect cluster(\"mycluster\").database(\"mydb\")", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster", cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_ClusterSyntax_ClusterOnly_ReturnsCluster()
    {
        // #connect cluster("mycluster")
        var parsed = ClientDirective.TryParse("#connect cluster(\"mycluster\")", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster", cluster);
        Assert.IsNull(database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_ClusterSyntax_WithPath_ReturnsDatabaseFromPath()
    {
        // #connect cluster("mycluster/mydb") - cluster contains a path
        var parsed = ClientDirective.TryParse("#connect cluster(\"mycluster/mydb\")", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual("mycluster", cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_ConnectionString_ReturnsConnectionAndParsedInfo()
    {
        // #connect "Data Source=https://mycluster.kusto.windows.net;Initial Catalog=mydb"
        var connectionString = "Data Source=https://mycluster.kusto.windows.net;Initial Catalog=mydb";
        var parsed = ClientDirective.TryParse($"#connect \"{connectionString}\"", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.AreEqual(connectionString, connection);
        Assert.AreEqual("mycluster.kusto.windows.net", cluster);
        Assert.AreEqual("mydb", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_SimpleUrl_ReturnsCluster()
    {
        // #connect "https://mycluster.kusto.windows.net"
        var parsed = ClientDirective.TryParse("#connect \"https://mycluster.kusto.windows.net\"", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNotNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", cluster);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_LogAnalyticsUrl_PreservesFullPath()
    {
        var parsed = ClientDirective.TryParse($"#connect \"{LogAnalyticsUri}\"", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.AreEqual(LogAnalyticsUri, connection);
        Assert.AreEqual(LogAnalyticsUri, cluster);
        Assert.AreEqual("NetDefaultDB", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_LogAnalyticsClusterSyntax_PreservesFullPath()
    {
        var parsed = ClientDirective.TryParse(
            $"#connect cluster(\"{LogAnalyticsUri}\").database(\"ws\")",
            out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsTrue(result);
        Assert.IsNull(connection);
        Assert.AreEqual(LogAnalyticsUri, cluster);
        Assert.AreEqual("ws", database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_AtPrefix_ReturnsFalse()
    {
        // #connect @variable - starts with @ which indicates a variable reference
        var parsed = ClientDirective.TryParse("#connect @variable", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsFalse(result);
        Assert.IsNull(connection);
        Assert.IsNull(cluster);
        Assert.IsNull(database);
    }

    [TestMethod]
    public void TryGetConnectionInfo_ConnectDirective_NoArguments_ReturnsFalse()
    {
        // #connect with no arguments
        var parsed = ClientDirective.TryParse("#connect", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsFalse(result);
        Assert.IsNull(connection);
        Assert.IsNull(cluster);
        Assert.IsNull(database);
    }

    #endregion

    #region TryGetConnectionInfo - Unknown Directive Tests

    [TestMethod]
    public void TryGetConnectionInfo_UnknownDirective_ReturnsFalse()
    {
        // #unknown directive
        var parsed = ClientDirective.TryParse("#unknown mycluster mydb", out var directive);
        Assert.IsTrue(parsed);

        var result = directive!.TryGetConnectionInfo(out var connection, out var cluster, out var database);

        Assert.IsFalse(result);
        Assert.IsNull(connection);
        Assert.IsNull(cluster);
        Assert.IsNull(database);
    }

    #endregion

    #region GetArgumentPairs Tests

    [TestMethod]
    public void GetArgumentPairs_WithNamedArguments_ReturnsKeyValuePairs()
    {
        // #directive name1=value1 name2=value2
        var parsed = ClientDirective.TryParse("#connect cluster(\"test\") option1=value1 option2=value2", out var directive);
        Assert.IsTrue(parsed);

        var pairs = directive!.GetArgumentPairs();

        Assert.AreEqual("value1", pairs["option1"]);
        Assert.AreEqual("value2", pairs["option2"]);
    }

    [TestMethod]
    public void GetArgumentPairs_WithExistingMap_MergesValues()
    {
        var parsed = ClientDirective.TryParse("#connect cluster(\"test\") option1=newvalue", out var directive);
        Assert.IsTrue(parsed);

        var existingMap = ImmutableDictionary<string, string>.Empty
            .Add("option1", "oldvalue")
            .Add("option2", "keepvalue");

        var pairs = directive!.GetArgumentPairs(existingMap);

        Assert.AreEqual("newvalue", pairs["option1"]);
        Assert.AreEqual("keepvalue", pairs["option2"]);
    }

    [TestMethod]
    public void GetArgumentPairs_WithNullValue_RemovesFromMap()
    {
        // When an argument has a name but no value, it should be removed from the map
        var parsed = ClientDirective.TryParse("#directive option1=", out var directive);
        Assert.IsTrue(parsed);

        var existingMap = ImmutableDictionary<string, string>.Empty
            .Add("option1", "oldvalue");

        var pairs = directive!.GetArgumentPairs(existingMap);

        Assert.IsFalse(pairs.ContainsKey("option1"));
    }

    [TestMethod]
    public void GetArgumentPairs_NoNamedArguments_ReturnsEmptyMap()
    {
        var parsed = ClientDirective.TryParse("#connect cluster(\"test\")", out var directive);
        Assert.IsTrue(parsed);

        var pairs = directive!.GetArgumentPairs();

        Assert.IsEmpty(pairs);
    }

    [TestMethod]
    public void GetArgumentPairs_NullMap_CreatesNewMap()
    {
        var parsed = ClientDirective.TryParse("#connect cluster(\"test\") option1=value1", out var directive);
        Assert.IsTrue(parsed);

        var pairs = directive!.GetArgumentPairs(null);

        Assert.HasCount(1, pairs);
        Assert.AreEqual("value1", pairs["option1"]);
    }

    #endregion
}
