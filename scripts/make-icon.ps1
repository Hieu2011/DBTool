# Draws the DbStudio icon (database cylinder on a rounded blue tile) and writes a multi-size .ico with PNG entries.
param([string]$OutFile, [string]$PreviewFile)
Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$intSize) {
    $objBmp = New-Object System.Drawing.Bitmap $intSize, $intSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $objG = [System.Drawing.Graphics]::FromImage($objBmp)
    $objG.SmoothingMode = 'AntiAlias'
    $objG.PixelOffsetMode = 'HighQuality'
    $objG.Clear([System.Drawing.Color]::Transparent)
    $s = $intSize / 64.0

    # rounded tile
    $r = 14 * $s
    $objPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $w = $intSize - 1
    $objPath.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $objPath.AddArc($w - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $objPath.AddArc($w - 2 * $r, $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $objPath.AddArc(0, $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $objPath.CloseFigure()
    $objRect = New-Object System.Drawing.RectangleF 0, 0, $intSize, $intSize
    $objBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $objRect, ([System.Drawing.Color]::FromArgb(255, 47, 128, 237)), ([System.Drawing.Color]::FromArgb(255, 23, 78, 166)), 90
    $objG.FillPath($objBrush, $objPath)

    # cylinder: three stacked discs
    $objWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $objBlue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 96, 196))
    $x = 16 * $s; $cw = 32 * $s; $eh = 11 * $s
    $objG.FillRectangle($objWhite, $x, 20 * $s, $cw, 25 * $s)
    $objG.FillEllipse($objWhite, $x, (45 * $s - $eh / 2), $cw, $eh)
    foreach ($y in 28.5, 37) {
        $objPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 30, 96, 196)), ([Math]::Max(1.2, 2.2 * $s))
        $objG.DrawArc($objPen, $x, ($y * $s - $eh / 2), $cw, $eh, 0, 180)
        $objPen.Dispose()
    }
    $objG.FillEllipse($objWhite, $x, (20 * $s - $eh / 2), $cw, $eh)
    $objPenTop = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 30, 96, 196)), ([Math]::Max(1.0, 1.6 * $s))
    $objG.DrawEllipse($objPenTop, ($x + 3 * $s), (20 * $s - $eh / 2 + 2 * $s), ($cw - 6 * $s), ($eh - 4 * $s))

    $objG.Dispose()
    $objStream = New-Object System.IO.MemoryStream
    $objBmp.Save($objStream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($intSize -eq 256 -and $PreviewFile) { $objBmp.Save($PreviewFile, [System.Drawing.Imaging.ImageFormat]::Png) }
    $objBmp.Dispose()
    , $objStream.ToArray()
}

$arrSizes = 16, 24, 32, 48, 64, 256
$arrPngs = $arrSizes | ForEach-Object { , (New-IconPng $_) }

$objOut = New-Object System.IO.MemoryStream
$objWriter = New-Object System.IO.BinaryWriter $objOut
$objWriter.Write([uint16]0); $objWriter.Write([uint16]1); $objWriter.Write([uint16]$arrSizes.Count)
$intOffset = 6 + 16 * $arrSizes.Count
for ($i = 0; $i -lt $arrSizes.Count; $i++) {
    $intSize = $arrSizes[$i]
    $objWriter.Write([byte]($intSize % 256)); $objWriter.Write([byte]($intSize % 256))
    $objWriter.Write([byte]0); $objWriter.Write([byte]0)
    $objWriter.Write([uint16]1); $objWriter.Write([uint16]32)
    $objWriter.Write([uint32]$arrPngs[$i].Length); $objWriter.Write([uint32]$intOffset)
    $intOffset += $arrPngs[$i].Length
}
foreach ($arrPng in $arrPngs) { $objWriter.Write($arrPng) }
$objWriter.Flush()
[System.IO.File]::WriteAllBytes($OutFile, $objOut.ToArray())
"wrote $OutFile ($($objOut.Length) bytes)"
