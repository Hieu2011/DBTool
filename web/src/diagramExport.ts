/** Diagram as a picture or a file. Drawn again as plain SVG shapes: the on-screen boxes are HTML and can't be rasterized. */

export interface ExportRow { name: string; type: string; key: boolean; primary: boolean }
export interface ExportNode { key: string; schema: string; name: string; highlight: boolean; rows: ExportRow[]; more: number; x: number; y: number }
export interface ExportLine { path: string; inferred: boolean }

export interface SvgArgs {
  arrNodes: ExportNode[]; arrLines: ExportLine[];
  intBoxWidth: number; intHeadHeight: number; intRowHeight: number;
  /** Tables of another schema show their schema next to the name. */
  strHomeSchema: string;
  /** Element whose CSS variables give the colors, so the picture matches the current theme. */
  objThemeSource: Element;
}

/** What "Export file" writes and "Import file" reads. */
export interface DiagramFile {
  format: 'dbstudio-diagram'; version: 1;
  diagram: string; exportedAt: string;
  nodes: ExportNode[];
  edges: { from: string; fromColumn?: string; to: string; toColumn?: string; label: string; inferred: boolean }[];
}

const MARGIN = 24;
const FONT = '"Cascadia Mono", Consolas, monospace';

const escapeXml = (strText: string) => strText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (strText: string, intChars: number) => (strText.length > intChars ? `${strText.slice(0, intChars - 1)}…` : strText);

export function buildSvg({ arrNodes, arrLines, intBoxWidth, intHeadHeight, intRowHeight, strHomeSchema, objThemeSource }: SvgArgs) {
  const objStyle = getComputedStyle(objThemeSource);
  const color = (strName: string, strFallback: string) => objStyle.getPropertyValue(strName).trim() || strFallback;
  const strBg = color('--bg', '#ffffff');
  const strPanel = color('--panel', '#ffffff');
  const strLine = color('--line', '#cccccc');
  const strFg = color('--fg', '#111111');
  const strMuted = color('--muted', '#666666');
  const strAccent = color('--accent', '#1f5fa8');

  const heightOf = (objNode: ExportNode) => intHeadHeight + (objNode.rows.length + (objNode.more > 0 ? 1 : 0)) * intRowHeight + 6;
  const intWidth = Math.max(0, ...arrNodes.map(objNode => objNode.x + intBoxWidth)) + MARGIN;
  const intHeight = Math.max(0, ...arrNodes.map(objNode => objNode.y + heightOf(objNode))) + MARGIN;

  const arrParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${intWidth}" height="${intHeight}" viewBox="0 0 ${intWidth} ${intHeight}" font-family='${FONT}' font-size="11">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
      + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${strMuted}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="${strBg}"/>`,
  ];

  for (const objLine of arrLines)
    arrParts.push(`<path d="${objLine.path}" fill="none" stroke="${strMuted}" stroke-width="1.4" marker-end="url(#arrow)"`
      + `${objLine.inferred ? ' stroke-dasharray="5 4"' : ''}/>`);

  for (const objNode of arrNodes) {
    const intNodeHeight = heightOf(objNode);
    const strBorder = objNode.highlight ? strAccent : strLine;
    const strTitle = objNode.schema === strHomeSchema ? objNode.name : `${objNode.name}  ${objNode.schema}`;
    arrParts.push(`<g transform="translate(${objNode.x} ${objNode.y})">`);
    arrParts.push(`<rect width="${intBoxWidth}" height="${intNodeHeight}" rx="4" fill="${strPanel}" stroke="${strBorder}"/>`);
    arrParts.push(`<path d="M 0 ${intHeadHeight} H ${intBoxWidth}" stroke="${strBorder}"/>`);
    arrParts.push(`<text x="8" y="${intHeadHeight / 2 + 4}" font-weight="600" font-size="12" fill="${strFg}">${escapeXml(clip(strTitle, 32))}</text>`);
    objNode.rows.forEach((objRow, intRow) => {
      const intY = intHeadHeight + intRow * intRowHeight + intRowHeight / 2 + 4;
      const strTag = objRow.primary ? 'PK' : objRow.key ? 'FK' : '';
      if (strTag) arrParts.push(`<text x="8" y="${intY}" font-size="9" font-weight="600" fill="${objRow.primary ? strAccent : strMuted}">${strTag}</text>`);
      arrParts.push(`<text x="34" y="${intY}" fill="${objRow.key || objRow.primary ? strFg : strMuted}">${escapeXml(clip(objRow.name, 18))}</text>`);
      arrParts.push(`<text x="${intBoxWidth - 8}" y="${intY}" text-anchor="end" font-size="10" fill="${strMuted}">`
        + `${escapeXml(clip(objRow.type.toLowerCase(), 15))}</text>`);
    });
    if (objNode.more > 0)
      arrParts.push(`<text x="8" y="${intHeadHeight + objNode.rows.length * intRowHeight + intRowHeight / 2 + 4}" fill="${strMuted}">`
        + `… ${objNode.more} more columns</text>`);
    arrParts.push('</g>');
  }

  arrParts.push('</svg>');
  return { svg: arrParts.join('\n'), width: intWidth, height: intHeight };
}

export function downloadBlob(objBlob: Blob, strFileName: string) {
  const strUrl = URL.createObjectURL(objBlob);
  const objLink = document.createElement('a');
  objLink.href = strUrl;
  objLink.download = strFileName;
  document.body.appendChild(objLink);
  objLink.click();
  objLink.remove();
  setTimeout(() => URL.revokeObjectURL(strUrl), 10_000); // the download has started by then
}

/** Twice the on-screen size so the picture stays sharp in a document. */
export function svgToPng(strSvg: string, intWidth: number, intHeight: number, intScale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const strUrl = URL.createObjectURL(new Blob([strSvg], { type: 'image/svg+xml;charset=utf-8' }));
    const objImage = new Image();
    objImage.onload = () => {
      URL.revokeObjectURL(strUrl);
      const objCanvas = document.createElement('canvas');
      objCanvas.width = intWidth * intScale;
      objCanvas.height = intHeight * intScale;
      const objContext = objCanvas.getContext('2d');
      if (!objContext) { reject(new Error('The picture could not be drawn.')); return; }
      objContext.scale(intScale, intScale);
      objContext.drawImage(objImage, 0, 0);
      objCanvas.toBlob(objBlob => (objBlob ? resolve(objBlob) : reject(new Error('The picture is too large to export as PNG; use SVG.'))), 'image/png');
    };
    objImage.onerror = () => { URL.revokeObjectURL(strUrl); reject(new Error('The picture could not be drawn.')); };
    objImage.src = strUrl;
  });
}

/** Positions from a diagram file, or an error message when the text is not one. */
export function parseDiagramFile(strText: string): { file: DiagramFile } | { error: string } {
  try {
    const objFile = JSON.parse(strText) as Partial<DiagramFile>;
    if (objFile.format !== 'dbstudio-diagram' || !Array.isArray(objFile.nodes)) return { error: 'This is not a DbStudio diagram file.' };
    const boolValid = objFile.nodes.every(objNode =>
      typeof objNode?.key === 'string' && Number.isFinite(objNode.x) && Number.isFinite(objNode.y));
    return boolValid ? { file: objFile as DiagramFile } : { error: 'The diagram file is damaged.' };
  } catch {
    return { error: 'The file is not valid JSON.' };
  }
}
