import { useEffect, useRef } from 'react';
import { monaco } from '../monaco';

/** Read-only text with syntax colors (documents as JSON...). Fills its parent. */
export function CodeView({ strText, strLanguage }: { strText: string; strLanguage: string }) {
  const refHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const objModel = monaco.editor.createModel(strText, strLanguage);
    const objEditor = monaco.editor.create(refHost.current!, {
      model: objModel,
      readOnly: true,
      multiCursorModifier: 'ctrlCmd', // Alt + drag = column block
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      padding: { top: 8 },
    });
    return () => {
      objEditor.dispose();
      objModel.dispose();
    };
  }, [strText, strLanguage]);

  return <div ref={refHost} className="h-full w-full" />;
}
