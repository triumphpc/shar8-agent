// Вопросы install в терминале (M1): строка с эхом и СКРЫТЫЙ ввод (raw-режим TTY, без эха) для токена и ключа API.
// Секреты не печатаются никуда: ни звёздочек, ни эха; Ctrl+C прерывает установку.

export class PromptAborted extends Error {
  constructor() { super('ввод прерван'); this.name = 'PromptAborted'; }
}

/**
 * @param {{stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream}} io
 * @returns {{ask:(q:string)=>Promise<string>, askSecret:(q:string)=>Promise<string>, close:()=>void}}
 */
export function createPrompter({ stdin, stdout }) {
  let pending = '';                  // остаток введённого после перевода строки (вставка нескольких строк сразу)
  const waiters = [];
  let closed = false;
  let flowing = false;

  const onData = (chunk) => {
    const w = waiters[0];
    if (!w) { pending += chunk.toString('utf8'); return; }
    w.feed(chunk.toString('utf8'));
  };
  const attach = () => {
    if (flowing) return;
    flowing = true;
    stdin.on('data', onData);
    stdin.resume?.();
  };
  const detachIfIdle = () => {
    if (waiters.length === 0 && flowing) { stdin.off('data', onData); stdin.pause?.(); flowing = false; }
  };

  function readLine({ secret }) {
    return new Promise((resolve, reject) => {
      let buf = '';
      let skipEscape = false;
      const raw = secret && typeof stdin.setRawMode === 'function';
      if (raw) stdin.setRawMode(true);
      const done = (fn, v) => {
        waiters.shift();
        if (raw) stdin.setRawMode(false);
        if (secret) stdout.write('\n');
        detachIfIdle();
        fn(v);
      };
      const w = {
        feed(text) {
          for (const ch of text) {
            if (skipEscape) { if (/[A-Za-z~]/.test(ch)) skipEscape = false; continue; }   // стрелки и т.п.
            if (ch === '\x1b') { skipEscape = true; continue; }
            if (ch === '\x03' || ch === '\x04') { done(reject, new PromptAborted()); return; }   // Ctrl+C, Ctrl+D
            if (ch === '\r' || ch === '\n') {
              const rest = text.slice(text.indexOf(ch) + 1);
              pending = rest.replace(/^\n/, '') + pending;
              done(resolve, buf);
              return;
            }
            if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
            if (ch >= ' ') buf += ch;
          }
        },
      };
      waiters.push(w);
      attach();
      if (pending) { const p = pending; pending = ''; w.feed(p); }
    });
  }

  return {
    async ask(question) {
      if (closed) throw new PromptAborted();
      stdout.write(question);
      return (await readLine({ secret: false })).trim();
    },
    async askSecret(question) {
      if (closed) throw new PromptAborted();
      stdout.write(question);
      return (await readLine({ secret: true })).trim();
    },
    close() { closed = true; for (const w of waiters.splice(0)) w.feed('\x03'); detachIfIdle(); },
  };
}
