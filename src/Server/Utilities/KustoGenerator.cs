// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using System.Numerics;
using Kusto.Language;
using Kusto.Language.Symbols;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Kusto.Vscode;

public static class KustoGenerator
{
    public static string GenerateDataTableExpression(DataTable table)
    {
        var schema = GenerateTableSchema(table);
        var rows = GenerateTableRows(table);
        return
            $$"""
            datatable {{schema}} {{rows}}
            """;
    }

    public static string GenerateTableSchema(DataTable table)
    {
        var columnDecls = string.Join(", ", table.Columns.OfType<DataColumn>().Select(c => $"{GetIdentifier(c.ColumnName)}: {GetKustoType(c.DataType)}"));
        return $"({columnDecls})";
    }

    public static string GenerateTableRows(DataTable table)
    {
        var rows = string.Join(",\n", table.Rows.OfType<DataRow>().Select(r => $"    {GenerateTableRow(r)}"));
        return
            $$"""
            [
            {{rows}}
            ]
            """;
    }

    public static string GenerateTableRow(DataRow row)
    {
        return string.Join(", ", row.Table.Columns.OfType<DataColumn>().Select(dc => GetLiteral(row[dc], GetKustoSymbol(dc.DataType))));
    }

    public static string GetLiteral(object value) =>
        GetLiteral(value, value.GetType());

    public static string GetLiteral(object? value, Type type) =>
        GetLiteral(value, GetKustoSymbol(type));

    public static string GetLiteral(object? value, ScalarSymbol symbol)
    {
        var isNull = value == null
            || value == DBNull.Value
            || value is INullable { IsNull: true };

        if (symbol == ScalarTypes.Bool)
        {
            return isNull ? "bool(null)" : Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? "true" : "false";
        }
        else if (symbol == ScalarTypes.Long)
        {
            return isNull ? "long(null)" : Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
        }
        else if (symbol == ScalarTypes.Real)
        {
            if (isNull)
                return "real(null)";
            if (value is float single)
            {
                return float.IsNaN(single) ? "real(nan)"
                    : float.IsPositiveInfinity(single) ? "real(+inf)"
                    : float.IsNegativeInfinity(single) ? "real(-inf)"
                    : single.ToString("R", CultureInfo.InvariantCulture);
            }
            var real = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return double.IsNaN(real) ? "real(nan)"
                : double.IsPositiveInfinity(real) ? "real(+inf)"
                : double.IsNegativeInfinity(real) ? "real(-inf)"
                : real.ToString("R", CultureInfo.InvariantCulture);
        }
        else if (symbol == ScalarTypes.Decimal)
        {
            var text = isNull
                ? "null"
                : value is SqlDecimal sqlDecimal
                    ? sqlDecimal.ToString()
                : Convert.ToDecimal(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            return $"decimal({text})";
        }
        else if (symbol == ScalarTypes.Int)
        {
            var text = isNull
                ? "null"
                : Convert.ToInt32(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            return $"int({text})";
        }
        else if (symbol == ScalarTypes.DateTime)
        {
            if (isNull)
                return "datetime(null)";
            var dt = Convert.ToDateTime(value, CultureInfo.InvariantCulture);
            dt = dt.Kind == DateTimeKind.Unspecified
                ? DateTime.SpecifyKind(dt, DateTimeKind.Utc)
                : dt.ToUniversalTime();
            return $"datetime({dt.ToString("O", CultureInfo.InvariantCulture)})";
        }
        else if (symbol == ScalarTypes.TimeSpan)
        {
            if (isNull)
                return "timespan(null)";
            var ts = (TimeSpan)value!;
            return $"timespan({ts.ToString("c", CultureInfo.InvariantCulture)})";
        }
        else if (symbol == ScalarTypes.Guid)
        {
            return $"guid({(isNull ? "null" : ((Guid)value!).ToString("D", CultureInfo.InvariantCulture))})";
        }
        else if (symbol is DynamicSymbol)
        {
            if (isNull)
                return "dynamic(null)";
            var dynamicValue = value is string json && TryParseJson(json, out var parsed)
                ? parsed
                : value is JToken token
                    ? token
                    : JToken.FromObject(value!);
            return $"dynamic({GetDynamicValue(dynamicValue)})";
        }
        else
        {
            if (isNull)
                return "''";
            return GetStringLiteral(Convert.ToString(value, CultureInfo.InvariantCulture)!);
        }
    }

    public static ScalarSymbol GetKustoSymbol(Type type)
    {
        // ignore through Nullable<T>
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Nullable<>))
            type = type.GetGenericArguments()[0];

        // handle types expected from kusto query results
        return Type.GetTypeCode(type) switch
        {
            TypeCode.Boolean => ScalarTypes.Bool,
            TypeCode.SByte => ScalarTypes.Bool,
            TypeCode.Byte => ScalarTypes.Bool,
            TypeCode.Int16 => ScalarTypes.Int,
            TypeCode.UInt16 => ScalarTypes.Int,
            TypeCode.Int32 => ScalarTypes.Int,
            TypeCode.UInt32 => ScalarTypes.Long,
            TypeCode.Int64 => ScalarTypes.Long,
            TypeCode.UInt64 => ScalarTypes.Decimal,
            TypeCode.Single => ScalarTypes.Real,
            TypeCode.Double => ScalarTypes.Real,
            TypeCode.Decimal => ScalarTypes.Decimal,
            TypeCode.String => ScalarTypes.String,
            TypeCode.DateTime => ScalarTypes.DateTime,
            _ =>
                type == typeof(TimeSpan) ? ScalarTypes.TimeSpan
                : type == typeof(Guid) ? ScalarTypes.Guid
                : type == typeof(System.Data.SqlTypes.SqlDecimal) ? ScalarTypes.Decimal
                : type == typeof(object) ? ScalarTypes.Dynamic
                : ScalarTypes.String // catch all
        };
    }

    public static string GetIdentifier(string name) =>
        KustoFacts.BracketNameIfNecessary(name);

    public static string GetStringLiteral(string value) =>
        KustoFacts.GetStringLiteral(value);

    public static string GetKustoType(Type type)
    {
        return GetKustoSymbol(type).Name;
    }

    private static bool TryParseJson(string text, out JToken token)
    {
        try
        {
            using var stringReader = new StringReader(text);
            using var jsonReader = new JsonTextReader(stringReader)
            {
                DateParseHandling = DateParseHandling.None
            };
            token = JToken.Load(jsonReader);
            return true;
        }
        catch (JsonException)
        {
            token = null!;
            return false;
        }
    }

    private static string GetDynamicValue(JToken token)
    {
        return token.Type switch
        {
            JTokenType.Object => $"{{{string.Join(
                ",",
                ((JObject)token).Properties().Select(property =>
                    $"{GetJsonString(property.Name)}:{GetDynamicValue(property.Value)}"))}}}",
            JTokenType.Array => $"[{string.Join(
                ",",
                ((JArray)token).Select(GetDynamicValue))}]",
            JTokenType.Null or JTokenType.Undefined => "null",
            JTokenType.Boolean => token.Value<bool>() ? "true" : "false",
            JTokenType.Integer => FormatDynamicInteger((JValue)token),
            JTokenType.Float => FormatDynamicReal((JValue)token),
            JTokenType.String => GetJsonString(token.Value<string>() ?? string.Empty),
            JTokenType.Date => GetLiteral(token.Value<DateTime>(), ScalarTypes.DateTime),
            JTokenType.Guid => GetLiteral(token.Value<Guid>(), ScalarTypes.Guid),
            JTokenType.TimeSpan => GetLiteral(token.Value<TimeSpan>(), ScalarTypes.TimeSpan),
            JTokenType.Uri => GetJsonString(token.Value<Uri>()?.ToString() ?? string.Empty),
            JTokenType.Bytes => GetJsonString(
                Convert.ToBase64String(token.Value<byte[]>() ?? [])),
            _ => throw new ArgumentException(
                $"Dynamic value contains unsupported JSON token type '{token.Type}'.",
                nameof(token))
        };
    }

    private static string FormatDynamicInteger(JValue value)
    {
        return value.Value switch
        {
            BigInteger integer => integer.ToString(CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => Convert.ToString(value.Value, CultureInfo.InvariantCulture) ?? "0"
        };
    }

    private static string FormatDynamicReal(JValue value)
    {
        if (value.Value is float single)
        {
            return float.IsNaN(single) ? "real(nan)"
                : float.IsPositiveInfinity(single) ? "real(+inf)"
                : float.IsNegativeInfinity(single) ? "real(-inf)"
                : single.ToString("R", CultureInfo.InvariantCulture);
        }
        if (value.Value is double real)
        {
            return double.IsNaN(real) ? "real(nan)"
                : double.IsPositiveInfinity(real) ? "real(+inf)"
                : double.IsNegativeInfinity(real) ? "real(-inf)"
                : real.ToString("R", CultureInfo.InvariantCulture);
        }
        return value.Value is IFormattable formattable
            ? formattable.ToString(null, CultureInfo.InvariantCulture)
            : Convert.ToString(value.Value, CultureInfo.InvariantCulture) ?? "0.0";
    }

    private static string GetJsonString(string value) =>
        JsonConvert.ToString(value);
}
