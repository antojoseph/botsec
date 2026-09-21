// Decode explorer-provided source data without evaluating any page JavaScript.
export function extractExplorerSources(html) {
  const marker = 'var editor_contractJsonData = ';
  const offset = html.indexOf(marker);
  if (offset < 0) throw new Error('Explorer source JSON not found');
  let i = offset + marker.length;
  while (/\s/.test(html[i] ?? '')) i++;
  if (html[i++] !== "'") throw new Error('Unexpected explorer string format');
  let decoded = '', closed = false;
  for (; i < html.length; i++) {
    const char = html[i];
    if (char === "'") { closed = true; break; }
    if (char !== '\\') { decoded += char; continue; }
    const escape = html[++i];
    if (escape === 'u' || escape === 'x') {
      const size = escape === 'u' ? 4 : 2;
      const hex = html.slice(i + 1, i + size + 1);
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) throw new Error('Invalid explorer string escape');
      decoded += String.fromCharCode(parseInt(hex, 16)); i += size;
    } else decoded += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escape] ?? escape;
  }
  if (!closed) throw new Error('Unterminated explorer string');
  const data = JSON.parse(decoded);
  if (data.language !== 'Solidity' || !data.sources || !Object.keys(data.sources).length) throw new Error('Missing Solidity sources');
  for (const [name, source] of Object.entries(data.sources)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || typeof source.content !== 'string') throw new Error('Invalid source entry');
  }
  return data;
}
