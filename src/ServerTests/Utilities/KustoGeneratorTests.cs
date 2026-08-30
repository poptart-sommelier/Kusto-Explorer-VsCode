// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Data.SqlTypes;
using System.Globalization;
using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Vscode;
using Newtonsoft.Json.Linq;

namespace Tests.Utilities;

[TestClass]
public class KustoGeneratorTests
{
    [TestMethod]
    public void LiteralsUseInvariantTypedFormattingAndSafeDynamicJson()
    {
        var previousCulture = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
        try
        {
            Assert.AreEqual("true", KustoGenerator.GetLiteral(true));
            Assert.AreEqual("true", KustoGenerator.GetLiteral((byte)1));
            Assert.AreEqual("false", KustoGenerator.GetLiteral((sbyte)0));
            Assert.AreEqual("1.2345678901234567", KustoGenerator.GetLiteral(1.2345678901234567d));
            Assert.AreEqual("decimal(12.5)", KustoGenerator.GetLiteral(12.5m));
            Assert.AreEqual(
                "decimal(12345678901234567890123456789012345678)",
                KustoGenerator.GetLiteral(
                    SqlDecimal.Parse("12345678901234567890123456789012345678")));
            Assert.AreEqual(
                "decimal(null)",
                KustoGenerator.GetLiteral(SqlDecimal.Null));
            Assert.AreEqual(
                "timespan(1.02:03:04.0050000)",
                KustoGenerator.GetLiteral(new TimeSpan(1, 2, 3, 4, 5)));
            Assert.AreEqual(
                "guid(01234567-89ab-cdef-0123-456789abcdef)",
                KustoGenerator.GetLiteral(Guid.Parse("01234567-89ab-cdef-0123-456789abcdef")));
            Assert.AreEqual(
                """dynamic({"text":"O'Reilly","count":2})""",
                KustoGenerator.GetLiteral(
                    JObject.Parse("""{"text":"O'Reilly","count":2}"""),
                    ScalarTypes.Dynamic));
            Assert.AreEqual(
                """dynamic("not json")""",
                KustoGenerator.GetLiteral("not json", ScalarTypes.Dynamic));
            Assert.AreEqual(
                """dynamic({"when":"2026-08-30T12:34:56Z"})""",
                KustoGenerator.GetLiteral(
                    """{"when":"2026-08-30T12:34:56Z"}""",
                    ScalarTypes.Dynamic));
            var nonfiniteDynamic = KustoGenerator.GetLiteral(
                new JArray(
                    double.NaN,
                    double.PositiveInfinity,
                    new JObject
                    {
                        ["negative"] = double.NegativeInfinity,
                        ["finite"] = 1.5
                    }),
                ScalarTypes.Dynamic);
            Assert.AreEqual(
                """dynamic([real(nan),real(+inf),{"negative":real(-inf),"finite":1.5}])""",
                nonfiniteDynamic);
            var parsed = KustoCode.ParseAndAnalyze(
                $"print Value = {nonfiniteDynamic}",
                GlobalState.Default);
            Assert.IsFalse(parsed.GetDiagnostics().Any(
                diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
        }
    }

    [TestMethod]
    public void ByteAndSByteMapProviderBoolSchemaAndRows()
    {
        var table = new System.Data.DataTable();
        table.Columns.Add("ByteBool", typeof(byte));
        table.Columns.Add("SByteBool", typeof(sbyte));
        table.Rows.Add((byte)1, (sbyte)0);

        Assert.AreSame(ScalarTypes.Bool, KustoGenerator.GetKustoSymbol(typeof(byte)));
        Assert.AreSame(ScalarTypes.Bool, KustoGenerator.GetKustoSymbol(typeof(sbyte)));
        Assert.AreEqual("(ByteBool: bool, SByteBool: bool)", KustoGenerator.GenerateTableSchema(table));
        Assert.AreEqual("true, false", KustoGenerator.GenerateTableRow(table.Rows[0]));
    }
}
