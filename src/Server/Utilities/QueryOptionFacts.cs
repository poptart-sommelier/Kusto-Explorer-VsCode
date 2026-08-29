// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Globalization;
using Kusto.Data.Common;

namespace Kusto.Vscode;

public static class QueryOptionFacts
{
    public static ImmutableDictionary<string, string> EnforceMaximumRows(
        ImmutableDictionary<string, string> options,
        long maximumRows)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumRows);

        if (options.TryGetValue(ClientRequestProperties.OptionTakeMaxRecords, out var configured)
            && long.TryParse(configured, NumberStyles.Integer, CultureInfo.InvariantCulture, out var configuredRows)
            && configuredRows > 0
            && configuredRows <= maximumRows)
        {
            return options;
        }

        return options.SetItem(
            ClientRequestProperties.OptionTakeMaxRecords,
            maximumRows.ToString(CultureInfo.InvariantCulture));
    }
}
