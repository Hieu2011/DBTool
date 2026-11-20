import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// Load Monaco from the bundle (no CDN): the app must work offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// MongoDB shell statements and scripts: no language service, only colors, brackets and comments.
const arrPairs = [
  { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
  { open: '"', close: '"' }, { open: "'", close: "'" },
];
monaco.languages.register({ id: 'mongodb' });
monaco.languages.setLanguageConfiguration('mongodb', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: arrPairs,
  surroundingPairs: arrPairs,
});
monaco.languages.setMonarchTokensProvider('mongodb', {
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/'(?:[^'\\]|\\.)*'/, 'string'],
      [/`(?:[^`\\]|\\.)*`/, 'string'],
      [/\b(?:true|false|null|undefined|db|use|show)\b/, 'keyword'],
      [/\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|of|in|new|try|catch|finally|throw|typeof|instanceof|switch|case|default)\b/, 'keyword'],
      [/\b(?:ObjectId|ISODate|NumberLong|NumberInt|NumberDecimal|Date|UUID|BinData|Timestamp)\b/, 'type'],
      [/\$[\w$]*/, 'keyword'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
});

// Redis console: one command per line, as in redis-cli.
monaco.languages.register({ id: 'redis' });
monaco.languages.setLanguageConfiguration('redis', {
  comments: { lineComment: '#' },
  autoClosingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
  surroundingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }],
});
monaco.languages.setMonarchTokensProvider('redis', {
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      [/^\s*[A-Za-z][\w.]*/, 'keyword'], // the command
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/'(?:[^'\\]|\\.)*'/, 'string'],
      [/(?<=\s)-?\d+(?:\.\d+)?(?=\s|$)/, 'number'],
    ],
  },
});

const objBase = {
  light: { bg: '#FBFCFD', fg: '#1C232E', line: '#EEF1F5', select: '#CFE0F5', gutter: '#8A93A1' },
  dark: { bg: '#161B22', fg: '#D8DEE7', line: '#1D232C', select: '#264B73', gutter: '#5D6775' },
};

monaco.editor.defineTheme('dbstudio-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '1F5FA8', fontStyle: 'bold' },
    { token: 'string', foreground: '8A4B08' },
    { token: 'number', foreground: '0E7C66' },
    { token: 'comment', foreground: '7A8594', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': objBase.light.bg,
    'editor.foreground': objBase.light.fg,
    'editor.lineHighlightBackground': objBase.light.line,
    'editor.selectionBackground': objBase.light.select,
    'editorLineNumber.foreground': objBase.light.gutter,
  },
});

monaco.editor.defineTheme('dbstudio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7DB3F0', fontStyle: 'bold' },
    { token: 'string', foreground: 'E3B072' },
    { token: 'number', foreground: '6FD0B5' },
    { token: 'comment', foreground: '6B7584', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': objBase.dark.bg,
    'editor.foreground': objBase.dark.fg,
    'editor.lineHighlightBackground': objBase.dark.line,
    'editor.selectionBackground': objBase.dark.select,
    'editorLineNumber.foreground': objBase.dark.gutter,
  },
});

const objMedia = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => monaco.editor.setTheme(objMedia.matches ? 'dbstudio-dark' : 'dbstudio-light');
applyTheme();
objMedia.addEventListener('change', applyTheme);

export { monaco };
