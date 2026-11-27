namespace DbStudio.Core;

public enum DbKind { PostgreSql, Oracle, MongoDb, Redis }

/// <summary>A saved connection. Password is plain text only in memory; the store encrypts it on disk.</summary>
public sealed class ConnectionProfile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public DbKind Kind { get; set; } = DbKind.PostgreSql;
    public string Host { get; set; } = "localhost";
    public int Port { get; set; }
    /// <summary>PostgreSQL: database name. Oracle: service name.</summary>
    public string Database { get; set; } = "";
    public string Username { get; set; } = "";
    public string? Password { get; set; }
    /// <summary>Extra driver options in connection-string form, e.g. "Timeout=15;Pooling=true".</summary>
    public string? Extra { get; set; }
    /// <summary>Environment color shown on the editor: slate | green | amber | red.</summary>
    public string Color { get; set; } = "slate";
}

/// <summary>What the API returns for a connection: never the password.</summary>
public sealed record ConnectionDto(
    Guid Id, string Name, DbKind Kind, string Host, int Port,
    string Database, string Username, bool HasPassword, string? Extra, string Color)
{
    public static ConnectionDto From(ConnectionProfile objProfile) => new(
        objProfile.Id, objProfile.Name, objProfile.Kind, objProfile.Host, objProfile.Port, objProfile.Database, objProfile.Username,
        !string.IsNullOrEmpty(objProfile.Password), objProfile.Extra, objProfile.Color);
}

/// <summary>Without SessionId the query runs on a one-shot connection.</summary>
public sealed record QueryRequest(
    Guid QueryId, Guid ConnectionId, string Sql, int MaxRows = 1000,
    Guid? SessionId = null, bool AutoCommit = true,
    // A result cut at MaxRows stays open on the session: QueryResult.Cursor reads on (POST /query/more).
    bool KeepOpen = false,
    // With KeepOpen: rows to pass over first. The grid already shows them and reads on after its open result was closed.
    int SkipRows = 0);

/// <summary>The next rows of a result that was left open.</summary>
public sealed record FetchMoreRequest(Guid QueryId, Guid SessionId, string Cursor, int MaxRows = 1000);

public sealed record SessionOpenRequest(Guid ConnectionId);

/// <summary>Streams a statement's rows into a file. Path comes from the Save dialog (POST /export/pick);
/// its extension, .csv or .xlsx, is the format.</summary>
public sealed record ExportRequest(Guid QueryId, Guid ConnectionId, string Sql, string Path);

/// <summary>Asks for the Save dialog. FileName is a suggestion, Format (csv / xlsx) the type selected at first.</summary>
public sealed record ExportPickRequest(string? FileName = null, string? Format = null);

public sealed record ExportPickResult(string Path);

/// <summary>Truncated: the format's row limit was reached before the data ended (Excel sheets hold 1,048,576 rows).</summary>
public sealed record ExportResult(string Path, long Rows, bool Truncated, long ElapsedMs);

public sealed record ResultColumn(string Name, string DataType);

public sealed class QueryResult
{
    public List<ResultColumn> Columns { get; } = [];
    public List<object?[]> Rows { get; } = [];
    public int RecordsAffected { get; set; } = -1;
    /// <summary>True when the query had more rows than MaxRows.</summary>
    public bool Truncated { get; set; }
    public long ElapsedMs { get; set; }
    /// <summary>Until the server answered the statement (first row ready). Null when not measured.</summary>
    public long? ExecuteMs { get; set; }
    /// <summary>Reading the returned rows from the server.</summary>
    public long? FetchMs { get; set; }
    /// <summary>Further result sets of the same statement (it returned several cursors).</summary>
    public List<QueryResult>? More { get; set; }
    /// <summary>Document databases: row i as formatted JSON, for the JSON view. Null for SQL results.</summary>
    public List<string>? Documents { get; set; }
    /// <summary>What the statement printed on the server (PostgreSQL notices, Oracle DBMS_OUTPUT). Null when nothing.</summary>
    public List<string>? Messages { get; set; }
    /// <summary>Set on a cut result the session kept open: the id that reads its next rows. Gone once another
    /// statement runs on the session.</summary>
    public string? Cursor { get; set; }
}

/// <summary>Error shown in the UI. Position is a 1-based character offset into the SQL, when the driver gives one.</summary>
public sealed record QueryError(string Message, int? Position = null, string? Code = null);

public sealed record ColumnMeta(string Name, string DataType);

public sealed record TableMeta(string Schema, string Name, string Type, List<ColumnMeta> Columns)
{
    /// <summary>Estimated row count from the catalog statistics; null when the database has none.</summary>
    public long? Rows { get; set; }
}

/// <summary>Function, procedure, sequence, package... Signature tells overloads apart (PostgreSQL).</summary>
public sealed record DbObjectInfo(string Schema, string Name, string Type, string? Signature = null);

/// <summary>Objects is empty and ObjectsError set when only the non-table objects failed to load.</summary>
/// <remarks>Schemas is set when the database is loaded one schema at a time (Oracle): it lists every schema,
/// while Tables / Objects only cover LoadedSchemas. Null means everything is loaded.</remarks>
public sealed record SchemaMetadata(
    List<TableMeta> Tables, DateTimeOffset LoadedAt,
    List<DbObjectInfo> Objects, string? ObjectsError = null,
    List<string>? Schemas = null, List<string>? LoadedSchemas = null)
{
    /// <summary>Adds (or replaces) one schema loaded separately.</summary>
    public SchemaMetadata Merge(SchemaMetadata objPart, string strSchema) => this with
    {
        Tables = [.. Tables.Where(objTable => objTable.Schema != strSchema), .. objPart.Tables],
        Objects = [.. Objects.Where(objItem => objItem.Schema != strSchema), .. objPart.Objects],
        ObjectsError = objPart.ObjectsError ?? ObjectsError,
        LoadedSchemas = [.. (LoadedSchemas ?? []).Where(strItem => strItem != strSchema), strSchema],
    };
}

/// <summary>One grid of the object viewer: Columns, Indexes, Constraints...</summary>
public sealed record ObjectSection(string Title, QueryResult Result);

/// <summary>Mode: IN, OUT, INOUT, or RETURN (a function's return value).</summary>
/// <summary>Where a result column comes from. Schema / Table / Column are null for an expression.</summary>
public sealed record ColumnOrigin(string Name, string? Schema, string? Table, string? Column);

/// <summary>A table some result columns come from. KeyColumns: its primary key, empty when it has none.</summary>
public sealed record EditableTable(string Schema, string Name, List<string> KeyColumns);

/// <summary>Columns: one entry per result column, in order.</summary>
public sealed record ResultOrigin(List<ColumnOrigin> Columns, List<EditableTable> Tables);

public sealed record DescribeRequest(Guid ConnectionId, string Sql);

public sealed record RoutineParameter(string Name, string DataType, string Mode, int Position);

public sealed record RoutineInfo(List<RoutineParameter> Parameters);

/// <summary>Value as typed by the user; null is SQL NULL. The provider converts it to the parameter's type.</summary>
public sealed record RoutineArgument(string Name, int Position, string? Value);

public sealed record RoutineExecuteRequest(
    Guid QueryId, Guid ConnectionId, DbObjectInfo Routine, List<RoutineArgument> Arguments, int MaxRows = 1000);

public sealed record RoutineOutput(string Name, string? Value);

/// <summary>Results: one grid per returned cursor / result set. Outputs: OUT parameters and scalar return values.</summary>
public sealed record RoutineResult(List<ObjectSection> Results, List<RoutineOutput> Outputs, long ElapsedMs);

public sealed record ObjectDetail(List<ObjectSection> Sections, string? Ddl, string? DdlError = null, string? Comment = null);
