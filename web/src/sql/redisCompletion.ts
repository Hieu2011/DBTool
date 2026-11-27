/** Autocomplete for Redis consoles (language "redis"): command names at the start of a line. */
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { builtinSnippets, snippetCode, snippetLabel } from './builtinSnippets';
import { getSnippets } from './snippets';

const COMMANDS = `PING INFO DBSIZE SELECT SCAN TYPE TTL PTTL EXPIRE PEXPIRE PERSIST EXISTS DEL UNLINK RENAME COPY OBJECT MEMORY
  GET SET SETEX SETNX GETSET GETDEL MGET MSET APPEND STRLEN INCR INCRBY INCRBYFLOAT DECR DECRBY GETRANGE SETRANGE
  HGET HSET HSETNX HMGET HGETALL HDEL HEXISTS HKEYS HVALS HLEN HINCRBY HSCAN
  LPUSH RPUSH LPOP RPOP LRANGE LLEN LINDEX LSET LREM LTRIM LINSERT
  SADD SREM SMEMBERS SISMEMBER SCARD SSCAN SUNION SINTER SDIFF SPOP SRANDMEMBER
  ZADD ZREM ZRANGE ZREVRANGE ZRANGEBYSCORE ZSCORE ZRANK ZCARD ZCOUNT ZINCRBY ZSCAN ZPOPMIN ZPOPMAX
  XADD XRANGE XREVRANGE XLEN XDEL XTRIM XINFO XREAD
  PUBLISH PUBSUB CONFIG CLIENT SLOWLOG LATENCY COMMAND FLUSHDB FLUSHALL KEYS EVAL EVALSHA JSON.GET JSON.SET`.split(/\s+/);

let boolRegistered = false;

export function registerRedisCompletion(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  objMonaco.languages.registerCompletionItemProvider('redis', {
    provideCompletionItems(objModel, objPosition) {
      const objWord = objModel.getWordUntilPosition(objPosition);
      // Only the first word of a line is a command.
      const strBefore = objModel.getLineContent(objPosition.lineNumber).slice(0, objWord.startColumn - 1);
      if (strBefore.trim() !== '') return { suggestions: [] };

      const objRange = {
        startLineNumber: objPosition.lineNumber, endLineNumber: objPosition.lineNumber,
        startColumn: objWord.startColumn, endColumn: objWord.endColumn,
      };
      const objKind = objMonaco.languages.CompletionItemKind;
      return {
        suggestions: [
          ...[...getSnippets().filter(objSnippet => objSnippet.prefix), ...builtinSnippets('redis', getSnippets())].map(objSnippet => ({
            label: snippetLabel(objSnippet), kind: objKind.Snippet, documentation: { value: '```text\n' + snippetCode(objSnippet.body) + '\n```' },
            insertText: objSnippet.body, insertTextRules: objMonaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: objRange, sortText: '0' + objSnippet.prefix,
          })),
          ...COMMANDS.map(strCommand => ({
            label: strCommand, kind: objKind.Keyword, insertText: strCommand + ' ', range: objRange, sortText: '1' + strCommand,
          })),
        ],
      };
    },
  });
}
