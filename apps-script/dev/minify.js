// Macht die ausgelieferte Seite kleiner, ohne etwas umzuschreiben: entfernt Kommentare (HTML, CSS, JavaScript),
// Einrückung und Leerzeilen. Inhalte von Zeichenketten, Template-Literalen und regulären Ausdrücken bleiben
// unangetastet. Ob das stimmt, prüft test.js: die gekürzten Vorlagen müssen Zeichen für Zeichen dasselbe HTML liefern.
'use strict';

const REGEX_BEFORE = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof']);

/** JavaScript ohne Kommentare, Einrückung und Leerzeilen. */
function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const stack = []; // 'tpl' = in einem Template-Literal; Zahl = Klammertiefe in ${ … }
  let lineStart = true; // Code-Zustand am Zeilenanfang: Einrückung fällt weg
  let last = ''; // letztes bedeutsames Zeichen im Code (für die Unterscheidung Division / regulärer Ausdruck)
  let word = '';

  const emit = (s) => { out += s; };
  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    if (out.length && !out.endsWith('\n')) out += '\n';
    lineStart = true;
  };

  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      const c = src[i];
      if (c === '\\') { emit(src.slice(i, i + 2)); i += 2; continue; }
      if (c === '`') { emit(c); stack.pop(); i++; last = '`'; word = ''; continue; }
      if (c === '$' && src[i + 1] === '{') { emit('${'); stack.push(0); i += 2; last = '{'; continue; }
      emit(c); i++; continue;
    }
    const c = src[i];
    if (c === '\n') { newline(); i++; last = last || ';'; continue; }
    if (lineStart && (c === ' ' || c === '\t' || c === '\r')) { i++; continue; }
    lineStart = false;
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Block-Kommentar ohne Ende');
      const body = src.slice(i, end + 2);
      i = end + 2;
      if (body.includes('\n')) newline(); else if (!/\s$/.test(out)) emit(' ');
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') throw new Error('Zeichenkette ohne Ende'); j++; }
      emit(src.slice(i, j + 1)); i = j + 1; last = c; word = ''; continue;
    }
    if (c === '`') { emit(c); stack.push('tpl'); i++; continue; }
    if (c === '/' && (last === '' || REGEX_BEFORE.has(last) || REGEX_WORDS.has(word))) {
      let j = i + 1, inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') throw new Error('Regulärer Ausdruck ohne Ende');
        if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      emit(src.slice(i, j)); i = j; last = '/'; word = ''; continue;
    }
    if (typeof top === 'number') {
      if (c === '{') stack[stack.length - 1]++;
      if (c === '}') {
        if (top === 0) { stack.pop(); emit(c); i++; continue; } // zurück ins Template-Literal
        stack[stack.length - 1]--;
      }
    }
    emit(c); i++;
    if (/[A-Za-z0-9_$]/.test(c)) { word = /[A-Za-z0-9_$]/.test(last) ? word + c : c; last = c; } else if (!/\s/.test(c)) { last = c; word = ''; }
  }
  if (stack.length) throw new Error('Template-Literal ohne Ende');
  return out.replace(/[ \t]+$/, '').replace(/\n+$/, '');
}

/** CSS ohne Kommentare, Einrückung und Leerzeilen. */
function stripCss(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('CSS-Kommentar ohne Ende');
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** HTML-Datei: Kommentare außerhalb von Skripten weg, Skripte und Styles einzeln kürzen. */
function stripHtml(src) {
  const parts = src.split(/(<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>)/i);
  return parts.map((part) => {
    let m = /^(<script\b[^>]*>)([\s\S]*?)(<\/script>)$/i.exec(part);
    if (m) return m[1] + '\n' + stripJs(m[2]) + '\n' + m[3];
    m = /^(<style\b[^>]*>)([\s\S]*?)(<\/style>)$/i.exec(part);
    if (m) return m[1] + '\n' + stripCss(m[2]) + '\n' + m[3];
    return part.replace(/<!--(?!\[)[\s\S]*?-->/g, '').replace(/\n[ \t]*\n+/g, '\n');
  }).join('');
}

module.exports = { stripJs, stripCss, stripHtml };
