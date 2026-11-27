/**
 * "Go to object" of a SQL editor: F12, the right-click menu and Ctrl + click open the table, view or routine
 * under the cursor (a column leads to its table). With Ctrl held the name looks like a link.
 * Everything is disposed with the editor.
 */
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { monaco } from '../monaco';
import type { DbObjectInfo } from '../types';
import { objectAt } from './hover';

export function attachObjectLinks(
  objEditor: Monaco.editor.IStandaloneCodeEditor,
  /** Oracle: the name is in a schema whose objects are not loaded yet. */
  fnLoadSchema: (strSchema: string) => Promise<unknown>,
  fnOpen: (objObject: DbObjectInfo) => void,
) {
  const objModel = objEditor.getModel();
  if (!objModel) return;

  const goToObject = async (objPosition: Monaco.Position | null) => {
    if (!objPosition) return;
    let objFound = objectAt(objModel, objPosition);
    if (objFound && 'loadSchema' in objFound) {
      await fnLoadSchema(objFound.loadSchema).catch(() => {});
      objFound = objectAt(objModel, objPosition);
    }
    if (objFound && !('loadSchema' in objFound)) {
      objEditor.setPosition(objPosition); // drops the cursor Ctrl + click just added
      fnOpen(objFound);
    }
  };
  objEditor.addAction({
    id: 'dbstudio.goToObject',
    label: 'Go to object',
    keybindings: [monaco.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: () => { void goToObject(objEditor.getPosition()); },
  });

  // With Ctrl held, a name that can be opened is underlined and takes the hand cursor.
  const objLink = objEditor.createDecorationsCollection();
  let strLinkAt = '';
  const clearLink = () => { if (strLinkAt) { strLinkAt = ''; objLink.clear(); } };
  objEditor.onMouseMove(objEvent => {
    const objPosition = objEvent.target.position;
    const objWord = objPosition && objEvent.event.ctrlKey && objEvent.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT
      ? objModel.getWordAtPosition(objPosition) : null;
    if (!objPosition || !objWord) return clearLink();
    const strAt = `${objPosition.lineNumber}:${objWord.startColumn}:${objWord.word}`;
    if (strAt === strLinkAt) return;
    clearLink();
    if (!objectAt(objModel, objPosition)) return;
    strLinkAt = strAt;
    objLink.set([{
      range: new monaco.Range(objPosition.lineNumber, objWord.startColumn, objPosition.lineNumber, objWord.endColumn),
      options: { inlineClassName: 'dbstudio-link' },
    }]);
  });
  objEditor.onMouseLeave(clearLink);
  objEditor.onKeyUp(objEvent => { if (objEvent.keyCode === monaco.KeyCode.Ctrl) clearLink(); });
  objModel.onDidChangeContent(clearLink);
  objEditor.onMouseDown(objEvent => {
    if (objEvent.event.ctrlKey && objEvent.event.leftButton && objEvent.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT)
      void goToObject(objEvent.target.position);
  });
}

/**
 * Alt + click adds a cursor where it lands; on a cursor it takes that one away (never the last).
 * Monaco moves the only cursor there on the press, so the cursors are remembered just before it
 * (capture phase) and put back on the release. Returns the cleanup.
 */
export function attachAltClickCursor(objEditor: Monaco.editor.IStandaloneCodeEditor, elHost: HTMLElement) {
  let objAltPress: { x: number; y: number; selections: Monaco.Selection[] } | null = null;
  const onAltPress = (objEvent: PointerEvent) => {
    objAltPress = objEvent.altKey && !objEvent.ctrlKey && !objEvent.shiftKey && !objEvent.metaKey && objEvent.button === 0
      ? { x: objEvent.pageX, y: objEvent.pageY, selections: objEditor.getSelections() ?? [] }
      : null;
  };
  elHost.addEventListener('pointerdown', onAltPress, true);
  objEditor.onMouseUp(objEvent => {
    const objPress = objAltPress;
    objAltPress = null;
    const objAt = objEvent.target.position;
    if (!objPress || !objAt || objEvent.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT &&
      objEvent.target.type !== monaco.editor.MouseTargetType.CONTENT_EMPTY) return;
    // Moved while pressed: that was a column block, leave it alone.
    if (Math.abs(objEvent.event.posx - objPress.x) > 3 || Math.abs(objEvent.event.posy - objPress.y) > 3) return;
    const arrKept = objPress.selections.filter(objItem => !(objItem.isEmpty() && objItem.getPosition().equals(objAt)));
    if (arrKept.length === 0) return;
    const boolRemove = arrKept.length < objPress.selections.length;
    objEditor.setSelections(boolRemove ? arrKept : [...arrKept, new monaco.Selection(objAt.lineNumber, objAt.column, objAt.lineNumber, objAt.column)]);
  });
  return () => elHost.removeEventListener('pointerdown', onAltPress, true);
}
