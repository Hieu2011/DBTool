using System.Data;
using System.Data.Common;
using DbStudio.Core;

namespace DbStudio.Providers;

public abstract partial class AdoProviderBase
{
    private const int MaxDescribedTables = 30;

    /// <summary>Primary key columns of a table in key order. Binds schema and name; one column: the column name.</summary>
    protected abstract string PrimaryKeySql { get; }

    public async Task<ResultOrigin> DescribeResultAsync(ConnectionProfile objProfile, string strSql, CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);

        var lstColumns = new List<ColumnOrigin>();
        await using (var objCmd = objConn.CreateCommand())
        {
            objCmd.CommandText = PrepareSql(strSql);
            // SchemaOnly: the driver describes the statement, nothing runs. KeyInfo: it also says which table each column comes from.
            await using var objReader = await objCmd.ExecuteReaderAsync(CommandBehavior.SchemaOnly | CommandBehavior.KeyInfo, objCancelToken);
            foreach (var objColumn in await objReader.GetColumnSchemaAsync(objCancelToken))
            {
                if (objColumn.IsHidden == true) continue; // added by the driver, not part of the result
                // An expression has no column to write back to.
                var boolPlain = objColumn.IsExpression != true
                    && !string.IsNullOrEmpty(objColumn.BaseTableName) && !string.IsNullOrEmpty(objColumn.BaseColumnName);
                lstColumns.Add(boolPlain
                    ? new ColumnOrigin(objColumn.ColumnName, string.IsNullOrEmpty(objColumn.BaseSchemaName) ? null : objColumn.BaseSchemaName,
                        objColumn.BaseTableName, objColumn.BaseColumnName)
                    : new ColumnOrigin(objColumn.ColumnName, null, null, null));
            }
        }

        var lstTables = new List<EditableTable>();
        var lstNames = lstColumns.Where(objColumn => objColumn.Schema is not null && objColumn.Table is not null)
            .Select(objColumn => (Schema: objColumn.Schema!, Table: objColumn.Table!)).Distinct().Take(MaxDescribedTables);
        foreach (var (strSchema, strTable) in lstNames)
        {
            var objKey = await ExecuteOnAsync(objConn, null, PrimaryKeySql, 100, objCancelToken, new DbObjectInfo(strSchema, strTable, "TABLE"));
            lstTables.Add(new EditableTable(strSchema, strTable, objKey.Rows.Select(arrRow => Convert.ToString(arrRow[0]) ?? "").ToList()));
        }
        return new ResultOrigin(lstColumns, lstTables);
    }
}
