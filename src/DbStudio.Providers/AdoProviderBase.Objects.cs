using System.Data;
using System.Data.Common;
using System.Globalization;
using DbStudio.Core;

namespace DbStudio.Providers;

// Object explorer: non-table objects, detail grids and DDL.
public abstract partial class AdoProviderBase
{
    private const int MaxSectionRows = 5000;

    /// <summary>Functions, sequences... Columns in order: schema, name, type, signature (nullable). Null = none.</summary>
    protected virtual string? ObjectsSql => null;

    /// <summary>Prefix of a named parameter in this provider's SQL.</summary>
    protected virtual string ParamMarker => "@";

    /// <summary>Called for commands that carry parameters.</summary>
    protected virtual void ConfigureParameterCommand(DbCommand objCmd) { }

    /// <summary>Detail grids of an object. The SQL may use the parameters schema, name, signature.</summary>
    protected virtual IReadOnlyList<(string Title, string Sql)> SectionQueries(DbObjectInfo objObject) => [];

    protected virtual Task<string?> LoadDdlAsync(DbConnection objConn, DbObjectInfo objObject, CancellationToken objCancelToken) =>
        Task.FromResult<string?>(null);

    /// <summary>Grids that are slow or rarely needed (procedures that use a table...). Run for the object
    /// viewer and when the tree opens that folder, not with the quick grids.</summary>
    protected virtual IReadOnlyList<(string Title, string Sql)> OnDemandSectionQueries(DbObjectInfo objObject) => [];

    /// <summary>Grids that only run when asked for by title (?section=), never with the object viewer's load.
    /// "Relations" feeds the diagram: direction (out = this table references, in = referenced by), constraint,
    /// schema, table, columns, other_columns.</summary>
    protected virtual IReadOnlyList<(string Title, string Sql)> ByNameSectionQueries(DbObjectInfo objObject) => [];

    public async Task<ObjectDetail> LoadObjectAsync(ConnectionProfile objProfile, DbObjectInfo objObject, bool boolFull, string? strSection,
        CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);

        IEnumerable<(string Title, string Sql)> lstQueries = SectionQueries(objObject);
        if (boolFull || strSection is not null) lstQueries = lstQueries.Concat(OnDemandSectionQueries(objObject));
        if (strSection is not null)
            lstQueries = lstQueries.Concat(ByNameSectionQueries(objObject)).Where(objQuery => objQuery.Title == strSection);

        var lstSections = new List<ObjectSection>();
        foreach (var (strTitle, strSql) in lstQueries)
            lstSections.Add(new ObjectSection(strTitle, await ExecuteOnAsync(objConn, null, strSql, MaxSectionRows, objCancelToken, objObject)));

        // The grids are still useful when the DDL can't be built (missing privilege, old server).
        string? strDdl = null, strDdlError = null;
        if (!boolFull || strSection is not null) return new ObjectDetail(lstSections, null);
        try { strDdl = await LoadDdlAsync(objConn, objObject, objCancelToken); }
        catch (DbException objEx) { strDdlError = DescribeError(objEx).Message; }

        // Optional: a comment that can't be read is simply not shown.
        string? strComment = null;
        if (CommentSql(objObject) is { } strCommentSql)
        {
            try { strComment = await ScalarAsync(objConn, strCommentSql, objObject, objCancelToken); }
            catch (DbException) { }
        }

        return new ObjectDetail(lstSections, strDdl, strDdlError, strComment);
    }

    /// <summary>One value: the object's comment. May use the parameters schema, name. Null = no comment for this type.</summary>
    protected virtual string? CommentSql(DbObjectInfo objObject) => null;

    protected async Task<string?> ScalarAsync(DbConnection objConn, string strSql, DbObjectInfo objObject,
        CancellationToken objCancelToken, params (string Name, string? Value)[] arrExtra)
    {
        await using var objCmd = objConn.CreateCommand();
        objCmd.CommandText = strSql;
        objCmd.CommandTimeout = 120;
        BindObject(objCmd, objObject, arrExtra);
        var objValue = await objCmd.ExecuteScalarAsync(objCancelToken);
        return objValue is null or DBNull ? null : Convert.ToString(objValue, CultureInfo.InvariantCulture);
    }

    /// <summary>First column of every row, nulls skipped.</summary>
    protected async Task<List<string>> ColumnAsync(DbConnection objConn, string strSql, DbObjectInfo objObject,
        CancellationToken objCancelToken, params (string Name, string? Value)[] arrExtra)
    {
        await using var objCmd = objConn.CreateCommand();
        objCmd.CommandText = strSql;
        objCmd.CommandTimeout = 120;
        BindObject(objCmd, objObject, arrExtra);
        var lstValues = new List<string>();
        await using var objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
        while (await objReader.ReadAsync(objCancelToken))
            if (!objReader.IsDBNull(0)) lstValues.Add(objReader.GetString(0));
        return lstValues;
    }

    /// <summary>Every row as text (null stays null).</summary>
    protected async Task<List<string?[]>> RowsAsync(DbConnection objConn, string strSql, DbObjectInfo objObject, CancellationToken objCancelToken)
    {
        await using var objCmd = objConn.CreateCommand();
        objCmd.CommandText = strSql;
        objCmd.CommandTimeout = 120;
        BindObject(objCmd, objObject);
        var lstRows = new List<string?[]>();
        await using var objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
        while (await objReader.ReadAsync(objCancelToken))
        {
            var arrRow = new string?[objReader.FieldCount];
            for (var intCol = 0; intCol < arrRow.Length; intCol++)
                arrRow[intCol] = objReader.IsDBNull(intCol) ? null : Convert.ToString(objReader.GetValue(intCol), CultureInfo.InvariantCulture);
            lstRows.Add(arrRow);
        }
        return lstRows;
    }

    private async Task<List<DbObjectInfo>> LoadObjectListAsync(DbConnection objConn, string? strSchema, CancellationToken objCancelToken)
    {
        var lstObjects = new List<DbObjectInfo>();
        if (ObjectsSql is not { } strSql) return lstObjects;

        await using var objCmd = objConn.CreateCommand();
        objCmd.CommandText = strSql;
        objCmd.CommandTimeout = 120;
        BindParams(objCmd, ("schema", strSchema));
        await using var objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
        while (await objReader.ReadAsync(objCancelToken))
            lstObjects.Add(new DbObjectInfo(objReader.GetString(0), objReader.GetString(1), objReader.GetString(2),
                objReader.IsDBNull(3) ? null : objReader.GetString(3)));
        return lstObjects;
    }

    /// <summary>All schema names, one column. Set it when MetadataSql / ObjectsSql load one schema at a time
    /// (parameter schema, null = current schema) because the whole catalog is too big to load at once.</summary>
    protected virtual string? SchemasSql => null;

    /// <summary>One value: the schema loaded when the schema parameter is null. Required with SchemasSql.</summary>
    protected virtual string? CurrentSchemaSql => null;

    /// <summary>Null when the provider loads every schema at once, or the list can't be read.</summary>
    private async Task<(List<string>? Schemas, List<string>? Loaded)> LoadSchemaListAsync(DbConnection objConn, CancellationToken objCancelToken)
    {
        if (SchemasSql is not { } strSql || CurrentSchemaSql is not { } strCurrentSql) return (null, null);
        try
        {
            var lstSchemas = new List<string>();
            await using (var objCmd = objConn.CreateCommand())
            {
                objCmd.CommandText = strSql;
                objCmd.CommandTimeout = 120;
                await using var objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
                while (await objReader.ReadAsync(objCancelToken)) lstSchemas.Add(objReader.GetString(0));
            }

            await using var objCurrentCmd = objConn.CreateCommand();
            objCurrentCmd.CommandText = strCurrentSql;
            var strCurrent = Convert.ToString(await objCurrentCmd.ExecuteScalarAsync(objCancelToken), CultureInfo.InvariantCulture);
            return string.IsNullOrEmpty(strCurrent) ? (null, null) : (lstSchemas, [strCurrent]);
        }
        catch (DbException)
        {
            return (null, null); // falls back to "current schema only"
        }
    }

    private void BindObject(DbCommand objCmd, DbObjectInfo objObject, params (string Name, string? Value)[] arrExtra) =>
        BindParams(objCmd, [("schema", objObject.Schema), ("name", objObject.Name), ("signature", objObject.Signature), .. arrExtra]);

    /// <summary>Adds only the parameters the SQL mentions: drivers reject unused ones.</summary>
    private void BindParams(DbCommand objCmd, params (string Name, string? Value)[] arrParams)
    {
        foreach (var (strName, strValue) in arrParams)
        {
            if (!objCmd.CommandText.Contains(ParamMarker + strName, StringComparison.Ordinal)) continue;
            var objParam = objCmd.CreateParameter();
            objParam.ParameterName = strName;
            objParam.DbType = DbType.String;
            objParam.Value = (object?)strValue ?? DBNull.Value;
            objCmd.Parameters.Add(objParam);
        }
        if (objCmd.Parameters.Count > 0) ConfigureParameterCommand(objCmd);
    }
}
