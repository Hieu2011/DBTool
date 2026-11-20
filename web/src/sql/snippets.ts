import type { Snippet } from '../types';

/** The user's snippets, shared by every editor's autocomplete. Loaded once by App, replaced when the dialog saves. */
let arrSnippets: Snippet[] = [];

export const setSnippets = (arrNext: Snippet[]) => { arrSnippets = arrNext; };
export const getSnippets = () => arrSnippets;
