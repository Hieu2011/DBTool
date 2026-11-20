using System.Globalization;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core;

namespace DbStudio.Host.Services;

/// <summary>Asks Explorer to show a file this app exported.</summary>
public sealed record ExportRevealRequest(string? Path);

/// <summary>A row sink that writes a file. Complete() finishes the file; Dispose alone leaves it unusable.</summary>
internal interface IExportSink : IRowSink, IDisposable
{
    long Rows { get; }
    bool Truncated { get; }
    void Complete();
}

internal static partial class ExportFiles
{
    private static readonly Guid DownloadsFolder = new("374DE290-123F-4565-9164-39C4925E467B");

    /// <summary>The user's Downloads folder (it can be moved, so the known-folder API is asked first).</summary>
    public static string DownloadsDirectory()
    {
        if (SHGetKnownFolderPath(DownloadsFolder, 0, IntPtr.Zero, out var strPath) == 0 && !string.IsNullOrEmpty(strPath)) return strPath;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    /// <summary>A new file in Downloads: the caller's name stripped to safe characters, a time stamp, the format's extension.</summary>
    public static string NewPath(string? strName, string strExtension)
    {
        var strBase = UnsafeNameChars().Replace(strName ?? "", "_").Trim('_', '.');
        if (strBase.Length == 0) strBase = "export";
        if (strBase.Length > 80) strBase = strBase[..80];

        var strDir = DownloadsDirectory();
        Directory.CreateDirectory(strDir);
        var strStem = $"{strBase}-{DateTime.Now:yyyyMMdd-HHmmss}";
        var strPath = Path.Combine(strDir, $"{strStem}.{strExtension}");
        for (var intCopy = 2; File.Exists(strPath); intCopy++) strPath = Path.Combine(strDir, $"{strStem}-{intCopy}.{strExtension}");
        return strPath;
    }

    /// <summary>Cell value as text, the same in every locale.</summary>
    public static string Text(object? objValue) => objValue switch
    {
        null => "",
        string strValue => strValue,
        bool boolValue => boolValue ? "true" : "false",
        IFormattable objFormattable => objFormattable.ToString(null, CultureInfo.InvariantCulture),
        _ => objValue.ToString() ?? "",
    };

    [GeneratedRegex(@"[^\w.\-]+")]
    private static partial Regex UnsafeNameChars();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid guidFolder, uint intFlags, IntPtr ptrToken,
        out string strPath);
}

/// <summary>UTF-8 with a BOM and CRLF: what Excel needs for Vietnamese text and multi-line cells. NULL is an empty cell.</summary>
internal sealed class CsvExportSink(string strPath) : IExportSink
{
    private static readonly char[] QuoteTriggers = [',', '"', '\r', '\n'];

    private readonly StreamWriter _objWriter = new(
        new FileStream(strPath, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16), new UTF8Encoding(true), 1 << 16);

    public long Rows { get; private set; }
    public bool Truncated => false;

    public void Begin(IReadOnlyList<ResultColumn> lstColumns)
    {
        for (var intIndex = 0; intIndex < lstColumns.Count; intIndex++)
        {
            if (intIndex > 0) _objWriter.Write(',');
            WriteCell(lstColumns[intIndex].Name);
        }
        _objWriter.Write("\r\n");
    }

    public bool Write(object?[] arrRow)
    {
        for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
        {
            if (intIndex > 0) _objWriter.Write(',');
            WriteCell(ExportFiles.Text(arrRow[intIndex]));
        }
        _objWriter.Write("\r\n");
        Rows++;
        return true;
    }

    public void Complete() => _objWriter.Flush();

    public void Dispose() => _objWriter.Dispose();

    private void WriteCell(string strValue)
    {
        if (strValue.IndexOfAny(QuoteTriggers) < 0) { _objWriter.Write(strValue); return; }
        _objWriter.Write('"');
        _objWriter.Write(strValue.Replace("\"", "\"\""));
        _objWriter.Write('"');
    }
}

/// <summary>
/// One-sheet workbook written row by row straight into the zip, so the size of the table doesn't matter.
/// Same layout as the UI's own exporter (web/src/exportData.ts): bold frozen header, numbers as numbers, the rest as text.
/// </summary>
internal sealed partial class XlsxExportSink : IExportSink
{
    private const long MaxDataRows = 1_048_575; // a sheet holds 1,048,576 rows, one is the header
    private const int CellMax = 32767;
    private const string XmlHead = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";

    private readonly ZipArchive _objZip;
    private StreamWriter? _objSheet;
    private bool[] _arrNumeric = [];

    public long Rows { get; private set; }
    public bool Truncated { get; private set; }

    public XlsxExportSink(string strPath)
    {
        _objZip = new ZipArchive(new FileStream(strPath, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16), ZipArchiveMode.Create);
    }

    public void Begin(IReadOnlyList<ResultColumn> lstColumns)
    {
        // The archive is written front to back: every small part first, the sheet last and left open for the rows.
        AddPart("[Content_Types].xml", XmlHead + """
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>
            """);
        AddPart("_rels/.rels", XmlHead + """
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>
            """);
        AddPart("xl/workbook.xml", XmlHead + """
            <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>
            """);
        AddPart("xl/_rels/workbook.xml.rels", XmlHead + """
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>
            """);
        // style 0 = default, style 1 = bold (header row)
        AddPart("xl/styles.xml", XmlHead + """
            <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>
            """);

        _arrNumeric = lstColumns.Select(objColumn => NumericType().IsMatch(objColumn.DataType)).ToArray();
        _objSheet = new StreamWriter(_objZip.CreateEntry("xl/worksheets/sheet1.xml", CompressionLevel.Fastest).Open(), new UTF8Encoding(false), 1 << 16);
        _objSheet.Write(XmlHead);
        _objSheet.Write("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
        _objSheet.Write("<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>");

        // The rows are not known yet, so the width comes from the header alone.
        _objSheet.Write("<cols>");
        for (var intIndex = 0; intIndex < lstColumns.Count; intIndex++)
        {
            var intWidth = Math.Clamp(lstColumns[intIndex].Name.Length + 4, 12, 60);
            _objSheet.Write($"<col min=\"{intIndex + 1}\" max=\"{intIndex + 1}\" width=\"{intWidth}\" customWidth=\"1\"/>");
        }
        _objSheet.Write("</cols><sheetData><row>");
        foreach (var objColumn in lstColumns) WriteText(objColumn.Name, " s=\"1\"");
        _objSheet.Write("</row>");
    }

    public bool Write(object?[] arrRow)
    {
        if (Rows >= MaxDataRows) { Truncated = true; return false; }

        var objSheet = _objSheet!;
        objSheet.Write("<row>");
        for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
        {
            var objValue = arrRow[intIndex];
            if (objValue is null) { objSheet.Write("<c/>"); continue; }
            if (NumberText(objValue, _arrNumeric[intIndex]) is { } strNumber)
            {
                objSheet.Write("<c><v>");
                objSheet.Write(strNumber);
                objSheet.Write("</v></c>");
            }
            else WriteText(ExportFiles.Text(objValue), "");
        }
        objSheet.Write("</row>");
        Rows++;
        return true;
    }

    public void Complete()
    {
        if (_objSheet is null) return; // the statement returned no result set: an empty archive is left for the caller to delete
        _objSheet.Write("</sheetData></worksheet>");
        _objSheet.Dispose();
        _objSheet = null;
    }

    public void Dispose()
    {
        try { _objSheet?.Dispose(); } catch (IOException) { /* disk full: the caller deletes the file */ }
        _objZip.Dispose(); // writes the zip directory and closes the file
    }

    private void AddPart(string strName, string strXml)
    {
        using var objWriter = new StreamWriter(_objZip.CreateEntry(strName, CompressionLevel.Fastest).Open(), new UTF8Encoding(false));
        objWriter.Write(strXml.Trim());
    }

    /// <summary>A value Excel can hold exactly (15 digits), else null: ids and big decimals stay text so they are not rounded.</summary>
    private static string? NumberText(object objValue, bool boolNumericColumn) => objValue switch
    {
        sbyte or byte or short or ushort or int or uint or long => ((IFormattable)objValue).ToString(null, CultureInfo.InvariantCulture),
        float decValue => float.IsFinite(decValue) ? decValue.ToString("R", CultureInfo.InvariantCulture) : null,
        double decValue => double.IsFinite(decValue) ? decValue.ToString("R", CultureInfo.InvariantCulture) : null,
        string strValue when boolNumericColumn && PlainNumber().IsMatch(strValue)
            && strValue.Count(char.IsAsciiDigit) - LeadingZeros(strValue) <= 15 => strValue,
        _ => null,
    };

    private static int LeadingZeros(string strNumber)
    {
        var intCount = 0;
        foreach (var chrDigit in strNumber)
        {
            if (chrDigit == '0') intCount++;
            else if (chrDigit is not ('-' or '.')) break;
        }
        return intCount;
    }

    private void WriteText(string strValue, string strStyle)
    {
        var objSheet = _objSheet!;
        objSheet.Write("<c t=\"inlineStr\"");
        objSheet.Write(strStyle);
        objSheet.Write("><is><t xml:space=\"preserve\">");
        var intLength = Math.Min(strValue.Length, CellMax);
        for (var intIndex = 0; intIndex < intLength; intIndex++)
        {
            var chrValue = strValue[intIndex];
            switch (chrValue)
            {
                case '&': objSheet.Write("&amp;"); break;
                case '<': objSheet.Write("&lt;"); break;
                case '>': objSheet.Write("&gt;"); break;
                // XML has no way to carry these at all.
                case < ' ' when chrValue is not ('\t' or '\n' or '\r'): break;
                case '￾' or '￿': break;
                default:
                    // Half of a surrogate pair cut off by the cell limit, or stray in the data, would break the file.
                    if (char.IsSurrogate(chrValue))
                    {
                        if (char.IsHighSurrogate(chrValue) && intIndex + 1 < intLength && char.IsLowSurrogate(strValue[intIndex + 1]))
                        {
                            objSheet.Write(chrValue);
                            objSheet.Write(strValue[++intIndex]);
                        }
                        break;
                    }
                    objSheet.Write(chrValue);
                    break;
            }
        }
        objSheet.Write("</t></is></c>");
    }

    [GeneratedRegex(@"^(int|integer|bigint|smallint|numeric|decimal|number|float|double|real|money|binary_(float|double))", RegexOptions.IgnoreCase)]
    private static partial Regex NumericType();

    [GeneratedRegex(@"^-?\d+(\.\d+)?$")]
    private static partial Regex PlainNumber();
}
