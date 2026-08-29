// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Language;
using Kusto.Language.Symbols;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Collections.Immutable;

namespace Kusto.Vscode;

/// <summary>
/// A <see cref="ISchemaManager"/> that pulls schema direct from the server.
/// </summary>
public class ServerSchemaSource : ISchemaSource
{
    private readonly IConnectionManager _connectionManager;
    private readonly ILogger? _logger;

    private ImmutableDictionary<string, ImmutableHashSet<string>> _clusterToBadDbNameMap =
        ImmutableDictionary<string, ImmutableHashSet<string>>.Empty;

    public ServerSchemaSource(
        IConnectionManager connectionManager,
        ILogger? logger = null)
    {
        _connectionManager = connectionManager;
        _logger = logger;
    }

    public async Task<ClusterInfo?> GetClusterInfoAsync(string clusterName, string? contextCluster, CancellationToken cancellationToken)
    {
        var resourceDatabase = ConnectionFacts.GetDatabaseName(clusterName, null);
        if (ConnectionFacts.IsAzureMonitorProxyUri(clusterName)
            && !string.IsNullOrEmpty(resourceDatabase))
        {
            return new ClusterInfo
            {
                Databases =
                [
                    new DatabaseName
                    {
                        Name = resourceDatabase,
                        AlternateName = resourceDatabase
                    }
                ]
            };
        }

        if (!_connectionManager.TryGetConnection(clusterName, null, contextCluster, out var conn))
            return null;

        var result = await conn.ExecuteAsync<DatabaseNamesResult>(
            ".show databases | project DatabaseName, PrettyName",
            cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var dbNames = result.Values?.Select(d =>
            new DatabaseName
            {
                Name = d.DatabaseName,
                AlternateName = d.PrettyName
            }).ToImmutableList()
            ?? ImmutableList<DatabaseName>.Empty;

        _logger?.Log($"ServerSchemaSource: Loaded schema for cluster: {clusterName}");

        return new ClusterInfo
        {
            Databases = dbNames,
        };
    }

    private bool IsBadDatabaseName(string clusterName, string databaseName)
    {
        return _clusterToBadDbNameMap.TryGetValue(clusterName, out var badDbNames)
            && badDbNames.Contains(databaseName);
    }

    private void AddBadDatabaseName(string clusterName, string databaseName)
    {
        // updates cluster bad database information
        _ = ImmutableInterlocked.AddOrUpdate(
            ref _clusterToBadDbNameMap,
            clusterName,
            _cluster => [databaseName],
            (_cluster, hset) => hset.Add(databaseName)
            );
    }

    public async Task<DatabaseInfo?> GetDatabaseInfoAsync(string clusterName, string databaseName, string? contextCluster, CancellationToken cancellationToken)
    {
        _logger?.Log($"ServerSchemaSource: Loading schema for database: {clusterName} {databaseName}");

        // if we've already determined this database name is bad, then bail out
        if (IsBadDatabaseName(clusterName, databaseName))
        {
            _logger?.Log($"ServerSchemaSource: Bad database name: {databaseName}");
            return null;
        }

        if (!_connectionManager.TryGetConnection(clusterName, databaseName, contextCluster, out var conn))
        {
            _logger?.Log($"ServerSchemaSource: Failed to get connection for database: {clusterName} {databaseName}");
            return null;
        }

        if (ConnectionFacts.IsAzureMonitorProxyUri(clusterName))
        {
            return await GetAzureMonitorDatabaseInfoAsync(conn, databaseName, cancellationToken).ConfigureAwait(false);
        }

        var dbName = await GetBothDatabaseNamesAsync(conn, databaseName, cancellationToken).ConfigureAwait(false);
        if (dbName == null)
        {
            AddBadDatabaseName(clusterName, databaseName);
            _logger?.Log($"ServerSchemaSource: Bad database name: {databaseName}");
            return null;
        }

        // use the primary database name if we need do refer to the database later
        if (dbName.Name != databaseName)
        {
            databaseName = dbName.Name;
        }

        // get all entities for this database
        var entities = await GetDatabaseEntitiesAsync(conn, dbName.Name, null, null, cancellationToken).ConfigureAwait(false);

        var tables = await CreateTableInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var externalTables = await CreateExternalTableInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var materializedViews = await CreateMaterializedViewInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var functions = await CreateFunctionInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var entityGroups = await CreateEntityGroupInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var graphModels = await CreateGraphModelInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
        var storedResults = await CreateStoredQueryResultInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);

        _logger?.Log($"ServerSchemaSource: Loaded schema for database: {clusterName} {databaseName}");

        return new DatabaseInfo
        {
            Name = dbName.Name,
            AlternateName = dbName.AlternateName,
            Tables = tables,
            ExternalTables = externalTables,
            MaterializedViews = materializedViews,
            Functions = functions,
            EntityGroups = entityGroups,
            GraphModels = graphModels,
            StoredQueryResults = storedResults
        };
    }

    private async Task<DatabaseInfo?> GetAzureMonitorDatabaseInfoAsync(
        IConnection connection,
        string databaseName,
        CancellationToken cancellationToken)
    {
        var escapedDatabaseName = KustoFacts.BracketNameIfNecessary(databaseName, KustoDialect.EngineCommand);
        var result = await connection.ExecuteAsync<DatabaseSchemaResult>(
            $".show database {escapedDatabaseName} schema as json",
            cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        var schemaText = result.Values?.FirstOrDefault()?.DatabaseSchema;
        if (string.IsNullOrWhiteSpace(schemaText))
            return null;

        var root = JObject.Parse(schemaText);
        var databases = root["Databases"] as JObject;
        var database = databases?.GetValue(databaseName, StringComparison.OrdinalIgnoreCase)
            ?? databases?.Properties().FirstOrDefault()?.Value;
        if (database == null)
            return null;

        return new DatabaseInfo
        {
            Name = database.Value<string>("Name") ?? databaseName,
            AlternateName = database.Value<string>("PrettyName"),
            Tables = CreateTablesFromDatabaseSchema(database),
            Functions = CreateFunctionsFromDatabaseSchema(database)
        };
    }

    private static ImmutableList<TableInfo> CreateTablesFromDatabaseSchema(JToken database)
    {
        if (database["Tables"] is not JObject tables)
            return ImmutableList<TableInfo>.Empty;

        return tables.Properties()
            .Select(table =>
            {
                var tableSchema = table.Value;
                var columns = tableSchema["OrderedColumns"] is JArray orderedColumns
                    ? orderedColumns
                        .Select(column => new ColumnInfo
                        {
                            Name = column.Value<string>("Name") ?? "",
                            Type = GetKustoTypeName(column.Value<string>("Type"))
                        })
                        .Where(column => column.Name.Length > 0)
                        .ToImmutableList()
                    : ImmutableList<ColumnInfo>.Empty;

                return new TableInfo
                {
                    Name = tableSchema.Value<string>("Name") ?? table.Name,
                    Columns = columns,
                    Description = tableSchema.Value<string>("DocString"),
                    Folder = tableSchema.Value<string>("Folder")
                };
            })
            .ToImmutableList();
    }

    private static ImmutableList<FunctionInfo> CreateFunctionsFromDatabaseSchema(JToken database)
    {
        if (database["Functions"] is not JObject functions)
            return ImmutableList<FunctionInfo>.Empty;

        return functions.Properties()
            .Select(function =>
            {
                var functionSchema = function.Value;
                return new FunctionInfo
                {
                    Name = functionSchema.Value<string>("Name") ?? function.Name,
                    Parameters = CreateFunctionParameters(functionSchema),
                    Body = functionSchema.Value<string>("Body") ?? "",
                    Description = functionSchema.Value<string>("DocString"),
                    Folder = functionSchema.Value<string>("Folder")
                };
            })
            .ToImmutableList();
    }

    private static string CreateFunctionParameters(JToken functionSchema)
    {
        if (functionSchema["InputParameters"] is not JArray parameters)
            return functionSchema.Value<string>("Parameters") ?? "()";

        return "(" + string.Join(", ", parameters.Select(parameter =>
        {
            var name = parameter.Value<string>("Name") ?? "";
            var type = GetKustoTypeName(parameter.Value<string>("Type"));
            return $"{KustoFacts.BracketNameIfNecessary(name)}:{type}";
        }).Where(parameter => !parameter.StartsWith(":", StringComparison.Ordinal))) + ")";
    }

    private static string GetKustoTypeName(string? typeName)
    {
        var name = typeName?.StartsWith("System.", StringComparison.OrdinalIgnoreCase) == true
            ? typeName["System.".Length..]
            : typeName;
        return name?.ToLowerInvariant() switch
        {
            "boolean" => "bool",
            "byte" or "sbyte" or "int16" or "uint16" or "int32" => "int",
            "uint32" or "int64" or "uint64" => "long",
            "single" or "double" => "real",
            "decimal" => "decimal",
            "datetime" => "datetime",
            "timespan" => "timespan",
            "guid" => "guid",
            "object" => "dynamic",
            "string" => "string",
            _ => "dynamic"
        };
    }

    /// <summary>
    /// Returns the database name and pretty name given either the database name or the pretty name.
    /// </summary>
    protected virtual async Task<DatabaseName> GetBothDatabaseNamesAsync(IConnection connection, string databaseNameOrPrettyName, CancellationToken cancellationToken)
    {
        var result = await connection.ExecuteAsync<DatabaseNamesResult>(
            $".show database identity | project DatabaseName, PrettyName",
            cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var dbInfo = result.Values?.FirstOrDefault();

        if (dbInfo == null)
            throw GetInvalidDatabaseException(databaseNameOrPrettyName);

        return new DatabaseName
        {
            Name = dbInfo.DatabaseName,
            AlternateName = dbInfo.PrettyName
        };
    }

    private static Exception GetInvalidDatabaseException(string databaseName) =>
        new InvalidOperationException($"Invalid database name: {databaseName}");

    private async Task<ImmutableList<DatabasesEntitiesShowCommandResult>> GetDatabaseEntitiesAsync(
        IConnection connection, string databaseName, EntityType? entityType, string? entityName, CancellationToken cancellationToken)
    {
        var command = CslCommandGenerator.GenerateDatabasesEntitiesShowCommand(
            filterOnDatabases: [databaseName], 
            filterOnEntityTypes: entityType != null ? [entityType.Value] : null, 
            filterOnEntityNames: entityName != null ? [entityName] : null
            );

        var results = await connection.ExecuteAsync<DatabasesEntitiesShowCommandResult>(command, cancellationToken: cancellationToken).ConfigureAwait(false);

        return results.Values?.ToImmutableList()
            ?? ImmutableList<DatabasesEntitiesShowCommandResult>.Empty;
    }

    public async Task<ImmutableList<TableInfo>> GetTableInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var connection))
            return ImmutableList<TableInfo>.Empty;

        var entities = await GetDatabaseEntitiesAsync(connection, databaseName, EntityType.Table, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateTableInfosAsync(connection, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<TableInfo>> CreateTableInfosAsync(
        IConnection connection, 
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        return entities
            .Where(e => e.EntityType == "Table")
            .Select(e => 
                new TableInfo
                {
                    Name = e.EntityName,
                    Columns = CreateColumnInfo(e.CslOutputSchema),
                    Description = e.DocString,
                    Folder = e.Folder

                }
            ).ToImmutableList();
    }

    private static ImmutableList<ColumnInfo> CreateColumnInfo(string schema)
    {
        return TableSymbol.From("(" + schema + ")").Columns
            .Select(c =>
                new ColumnInfo
                {
                    Name = c.Name,
                    Type = c.Type.Name
                }
            ).ToImmutableList();
    }

    public async Task<ImmutableList<ExternalTableInfo>> GetExternalTableInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var connection))
            return ImmutableList<ExternalTableInfo>.Empty;

        var entities = await GetDatabaseEntitiesAsync(connection, databaseName, EntityType.ExternalTable, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateExternalTableInfosAsync(connection, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<ExternalTableInfo>> CreateExternalTableInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        return entities
            .Where(e => e.EntityType == "ExternalTable")
            .Select(e => new ExternalTableInfo
            {
                Name = e.EntityName,
                Columns = CreateColumnInfo(e.CslOutputSchema),
                Description = e.DocString,
                Folder = e.Folder
            }).ToImmutableList();
    }

    public async Task<ImmutableList<MaterializedViewInfo>> GetMaterializedViewInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
            return ImmutableList<MaterializedViewInfo>.Empty;
        var entities = await this.GetDatabaseEntitiesAsync(conn, databaseName, EntityType.MaterializedView, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateMaterializedViewInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<MaterializedViewInfo>> CreateMaterializedViewInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        if (entities.Count == 0)
            return ImmutableList<MaterializedViewInfo>.Empty;

        var mviews = entities.Where(e => e.EntityType == "MaterializedView").ToImmutableList();

        if (mviews.Count == 0)
            return ImmutableList<MaterializedViewInfo>.Empty;

        var infos = new List<MaterializedViewInfo>();

        foreach (var mv in mviews)
        {
            var mvCommand = CslCommandGenerator.GenerateMaterializedViewShowCommand(mv.EntityName);
            var mvShow = (await connection.ExecuteAsync<MaterializedViewShowCommandResult>(mvCommand, cancellationToken: cancellationToken).ConfigureAwait(false)).Values?.FirstOrDefault();

            if (mvShow != null)
            {
                infos.Add(new MaterializedViewInfo
                {
                    Name = mv.EntityName,
                    Source = mvShow.SourceTable,
                    Query = mvShow.Query,
                    Columns = CreateColumnInfo(mv.CslOutputSchema),
                    Description = mv.DocString,
                    Folder = mv.Folder
                });
            }
        }

        return infos.ToImmutableList();
    }

    public async Task<ImmutableList<FunctionInfo>> GetFunctionInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
            return ImmutableList<FunctionInfo>.Empty;
        var entities = await GetDatabaseEntitiesAsync(conn, databaseName, EntityType.Function, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateFunctionInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<FunctionInfo>> CreateFunctionInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        return entities
            .Where(e => e.EntityType == "Function")
            .Select(e => new FunctionInfo
            {
                Name = e.EntityName,
                Parameters = e.CslInputSchema,
                Body = e.Content,
                Description = e.DocString,
                Folder = e.Folder
            })
            .ToImmutableList();
    }

    public async Task<ImmutableList<EntityGroupInfo>> GetEntityGroupInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
            return ImmutableList<EntityGroupInfo>.Empty;
        var entities = await GetDatabaseEntitiesAsync(conn, databaseName, EntityType.EntityGroup, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateEntityGroupInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<EntityGroupInfo>> CreateEntityGroupInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        return entities
            .Where(e => e.EntityType == "EntityGroup")
            .Select(e => new EntityGroupInfo        
            {
                Name = e.EntityName,
                Entities = CreateEntities(e.Content),
                Description = e.DocString,
                Folder = e.Folder
            }).ToImmutableList();
    }

    private ImmutableList<string> CreateEntities(string definition)
    {
        var expressionText = GetEntityGroupExpression(definition);
        var group = (Kusto.Language.Syntax.EntityGroup)Kusto.Language.Parsing.QueryParser.ParseEntityGroup(expressionText);
        return group.Entities.Select(ee => ee.Element.ToString(Language.Syntax.IncludeTrivia.Minimal)).ToImmutableList();
    }

    private static string GetEntityGroupExpression(string definition)
    {
        definition = definition.Trim();
        if (definition.StartsWith("entity_group"))
        {
            return definition;
        }

        string text = definition;
        if (definition.StartsWith("[") && definition.EndsWith("]"))
        {
            text = definition.Substring(1, definition.Length - 2);
        }

        text = text.Trim();
        if (text.StartsWith("\"") || text.StartsWith("'"))
        {
            text = KustoFacts.GetStringLiteralValue(text);
        }

        return "entity_group [" + text + "]";
    }

    public async Task<ImmutableList<GraphModelInfo>> GetGraphModelInfosAsync(      
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
            return ImmutableList<GraphModelInfo>.Empty;
        var entities = await this.GetDatabaseEntitiesAsync(conn, databaseName, EntityType.Graph, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateGraphModelInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<GraphModelInfo>> CreateGraphModelInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        if (entities.Count == 0)
            return ImmutableList<GraphModelInfo>.Empty;

        var graphEntities = entities.Where(e => e.EntityType == "Graph").ToImmutableList();
        if (graphEntities.Count == 0)
            return ImmutableList<GraphModelInfo>.Empty;

        var graphModelSnapshots = (await connection.ExecuteAsync<LoadGraphModelSnapshotsResult>(
            ".show graph_snapshots * | summarize Snapshots=make_list(Name) by ModelName",
            cancellationToken: cancellationToken)
            .ConfigureAwait(false))
            .Values
            ?? ImmutableList<LoadGraphModelSnapshotsResult>.Empty;

        var snapshotMap = graphModelSnapshots?.ToImmutableDictionary(snaps => snaps.ModelName, snaps => snaps.Snapshots)
            ?? ImmutableDictionary<string, string>.Empty;

        return graphEntities
            .Select(e =>
            {
                var snapshotNames = ImmutableList<string>.Empty;
                if (snapshotMap.TryGetValue(e.EntityName, out var snapshots)
                    && !string.IsNullOrWhiteSpace(snapshots))
                {
                    try
                    {
                        snapshotNames = JsonConvert.DeserializeObject<ImmutableList<string>>(snapshots) ?? ImmutableList<string>.Empty;                      
                    }
                    catch (JsonException je)
                    {
                        _logger?.Log($"ServerSchemaSource: Failed to parse snapshots for graph model '{e.EntityName}': {je.Message}");
                    }
                }

                return new GraphModelInfo
                {
                    Name = e.EntityName,
                    Model = e.Content,
                    Snapshots = snapshotNames,
                    Description = e.DocString,
                    Folder = e.Folder
                };                       
            })
            .ToImmutableList();
    }

    public async Task<ImmutableList<StoredQueryResultInfo>> GetStoredQueryResultInfosAsync(
        string clusterName, string databaseName, string? entityName, CancellationToken cancellationToken)
    {
        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
            return ImmutableList<StoredQueryResultInfo>.Empty;
        var entities = await GetDatabaseEntitiesAsync(conn, databaseName, EntityType.StoredQueryResult, entityName, cancellationToken).ConfigureAwait(false);
        return await CreateStoredQueryResultInfosAsync(conn, entities, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ImmutableList<StoredQueryResultInfo>> CreateStoredQueryResultInfosAsync(
        IConnection connection,
        ImmutableList<DatabasesEntitiesShowCommandResult> entities,
        CancellationToken cancellationToken)
    {
        return entities
            .Where(e => e.EntityType == "StoredQueryResult")
            .Select(e =>
                new StoredQueryResultInfo
                {
                    Name = e.EntityName,
                    Columns = CreateColumnInfo(e.CslOutputSchema),
                    Description = e.DocString,
                    Folder = e.Folder
                }
            ).ToImmutableList();
    }

    public async Task<ExternalTableInfoEx?> GetExternalTableInfoExAsync(string clusterName, string databaseName, string name, CancellationToken cancellationToken)
    {
        var etInfo = (await this.GetExternalTableInfosAsync(clusterName, databaseName, name, cancellationToken).ConfigureAwait(false)).FirstOrDefault();
        if (etInfo == null)
            return null;

        if (!_connectionManager.TryGetConnection(clusterName, databaseName, out var connection))
            return null;

        var command = $".show external table {KustoFacts.BracketNameIfNecessary(name, KustoDialect.EngineCommand)}";
        var result = (await connection.ExecuteAsync<ShowExternalTableResult>(command, null, null, cancellationToken)).Values?.FirstOrDefault();
        if (result != null)
        {
            var props = DeserializeProperties(result.Properties);
            var connstrs = DeserializeList<string>(result.ConnectionStrings);
            var partitions = DeserializeList<ExternalTablePartition>(result.Partitions);

            return new ExternalTableInfoEx
            {
                Name = result.TableName,
                Columns = etInfo.Columns,
                Folder = result.Folder,
                Description = result.DocString,
                Type = result.TableType,
                Properties = props,
                Partitions = partitions,
                PathFormat = result.PathFormat,
                ConnectionStrings = connstrs,
            };
        }

        return null;
    }

    private ImmutableDictionary<string, object> DeserializeProperties(string? text)
    {
        return text != null
            && JsonConvert.DeserializeObject<ImmutableDictionary<string, object>>(text) is { } map
            ? map
            : ImmutableDictionary<string, object>.Empty;
    }

    private ImmutableList<T> DeserializeList<T>(string? text)
    {
        return text != null
            && JsonConvert.DeserializeObject<ImmutableList<T>>(text) is { } list
            ? list
            : ImmutableList<T>.Empty;
    }

#nullable disable

    public class ShowExternalTableResult
    {
        public string TableName;
        public string TableType;
        public string Folder;
        public string DocString;
        public string Properties;
        public string ConnectionStrings;
        public string Partitions;
        public string PathFormat;
    }

    public class DatabaseNamesResult
    {
        public string DatabaseName;
        public string PrettyName;
    }

    public class DatabaseSchemaResult
    {
        public string DatabaseSchema;
    }

    public class LoadGraphModelSnapshotsResult
    {
        public string ModelName;
        public string Snapshots;
    }
    #nullable restore
}
