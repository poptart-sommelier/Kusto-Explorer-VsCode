// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Vscode;

namespace Tests.Utilities;

[TestClass]
public class ConnectionFactsTests
{
    private const string DefaultDomain = ".kusto.windows.net";
    private const string LogAnalyticsUri =
        "https://ade.loganalytics.io/subscriptions/sub/resourcegroups/rg/providers/microsoft.operationalinsights/workspaces/ws";

    #region GetClusterName Tests

    [TestMethod]
    public void GetClusterName_LogAnalyticsUri_PreservesFullPath()
    {
        var result = ConnectionFacts.GetClusterName(LogAnalyticsUri, DefaultDomain);

        Assert.AreEqual(LogAnalyticsUri, result);
    }

    [TestMethod]
    public void GetClusterName_LogAnalyticsUriWithTrailingSlash_RemovesTrailingSlash()
    {
        var result = ConnectionFacts.GetClusterName($"{LogAnalyticsUri}/", DefaultDomain);

        Assert.AreEqual(LogAnalyticsUri, result);
    }

    [TestMethod]
    public void GetClusterName_StandardClusterUri_ReturnsHostName()
    {
        var result = ConnectionFacts.GetClusterName("https://mycluster.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetClusterName_StandardClusterUriWithDatabasePath_ReturnsHostName()
    {
        var result = ConnectionFacts.GetClusterName("https://mycluster.kusto.windows.net/mydb", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    #endregion

    #region GetFullHostName - Cluster Name Tests

    [TestMethod]
    public void GetFullHostName_ShortClusterName_AppendsDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_FullHostName_ReturnsAsIs()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_DifferentDomain_ReturnsAsIs()
    {
        // If the cluster already has a domain, it should not be replaced
        var result = ConnectionFacts.GetFullHostName("mycluster.eastus.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.eastus.kusto.windows.net", result);
    }

    #endregion

    #region GetFullHostName - URI Tests

    [TestMethod]
    public void GetFullHostName_HttpsUri_ExtractsHostName()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_HttpsUriWithPath_ExtractsHostName()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net/mydb", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_HttpsUriShortName_AppendsDomain()
    {
        // URI with just cluster name (no domain)
        var result = ConnectionFacts.GetFullHostName("https://mycluster", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    #endregion

    #region GetFullHostName - Custom Domain Tests

    [TestMethod]
    public void GetFullHostName_CustomDefaultDomain_AppendsCustomDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", ".kusto.azure.com");

        Assert.AreEqual("mycluster.kusto.azure.com", result);
    }

    [TestMethod]
    public void GetFullHostName_AriaDomain_AppendsAriaDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", ".kusto.aria.microsoft.com");

        Assert.AreEqual("mycluster.kusto.aria.microsoft.com", result);
    }

    #endregion

    #region GetFullHostName - Edge Cases

    [TestMethod]
    public void GetFullHostName_EmptyString_ReturnsWithDomain()
    {
        var result = ConnectionFacts.GetFullHostName("", DefaultDomain);

        // Empty names are always empty, even with a domain appended
        Assert.AreEqual("", result);
    }

    [TestMethod]
    public void GetFullHostName_ClusterWithPort_HandlesPort()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net:443", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    #endregion
}
