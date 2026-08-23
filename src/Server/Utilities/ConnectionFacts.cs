using Kusto.Language;
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

public static class ConnectionFacts
{
    /// <summary>
    /// Gets the cluster identity from a cluster name or URI.
    /// Path-bearing URIs are preserved because Azure Monitor proxy endpoints use
    /// the path to identify the target workspace or Application Insights resource.
    /// </summary>
    public static string GetClusterName(string clusterNameOrUri, string defaultDomain)
    {
        if (Uri.TryCreate(clusterNameOrUri, UriKind.Absolute, out var uri)
            && IsAzureMonitorProxyHost(uri.Host)
            && uri.AbsolutePath != "/")
        {
            return clusterNameOrUri.TrimEnd('/');
        }

        return GetFullHostName(clusterNameOrUri, defaultDomain);
    }

    public static bool IsAzureMonitorProxyUri(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && IsAzureMonitorProxyHost(uri.Host)
            && uri.AbsolutePath != "/";
    }

    public static string? GetDatabaseName(string dataSource, string? databaseName)
    {
        if (!string.IsNullOrEmpty(databaseName)
            && !databaseName.Equals("NetDefaultDB", StringComparison.OrdinalIgnoreCase))
        {
            return databaseName;
        }

        if (!Uri.TryCreate(dataSource, UriKind.Absolute, out var uri)
            || !IsAzureMonitorProxyHost(uri.Host))
        {
            return databaseName;
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 4
            || !segments[^4].Equals("providers", StringComparison.OrdinalIgnoreCase))
        {
            return databaseName;
        }

        var isLogAnalyticsWorkspace =
            segments[^3].Equals("microsoft.operationalinsights", StringComparison.OrdinalIgnoreCase)
            && segments[^2].Equals("workspaces", StringComparison.OrdinalIgnoreCase);
        var isApplicationInsightsComponent =
            segments[^3].Equals("microsoft.insights", StringComparison.OrdinalIgnoreCase)
            && segments[^2].Equals("components", StringComparison.OrdinalIgnoreCase);

        return isLogAnalyticsWorkspace || isApplicationInsightsComponent
            ? Uri.UnescapeDataString(segments[^1])
            : databaseName;
    }

    private static bool IsAzureMonitorProxyHost(string host)
    {
        return host.Equals("ade.loganalytics.io", StringComparison.OrdinalIgnoreCase)
            || host.Equals("ade.applicationinsights.io", StringComparison.OrdinalIgnoreCase)
            || host.Equals("adx.monitor.azure.us", StringComparison.OrdinalIgnoreCase)
            || host.Equals("adx.monitor.azure.cn", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Gets full host name (including domain) from a cluster name or URI.
    /// If the input is already a full host name, it is returned as is.
    /// If the input is a cluster name without a domain, the default domain is appended to it.
    /// If the input is a URI, the host name is extracted.
    /// </summary>
    public static string GetFullHostName(string clusterNameOrUri, string defaultDomain)
    {
        return KustoFacts.GetFullHostName(KustoFacts.GetHostName(clusterNameOrUri), defaultDomain);
    }
}