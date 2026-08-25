// Render model text without treating any part of it as markup.
function appendTextWithBreaks(parent, text, doc) {
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    if (index) parent.appendChild(doc.createElement('br'));
    parent.appendChild(doc.createTextNode(line));
  });
}

export function renderLongReply(text, displayName, doc = globalThis.document) {
  const div = doc.createElement('div');
  div.className = 'n';

  const strong = doc.createElement('strong');
  strong.textContent = `${displayName}:`;
  div.appendChild(strong);
  div.appendChild(doc.createTextNode(' '));

  const source = String(text);
  const tokenRe = /```(\w*)\n?([\s\S]*?)```|`([^`]+)`/g;
  let cursor = 0;
  let match;
  while ((match = tokenRe.exec(source))) {
    appendTextWithBreaks(div, source.slice(cursor, match.index), doc);
    if (match[2] !== undefined) {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = match[2];
      pre.appendChild(code);
      div.appendChild(pre);
    } else {
      const code = doc.createElement('code');
      code.textContent = match[3];
      div.appendChild(code);
    }
    cursor = tokenRe.lastIndex;
  }
  appendTextWithBreaks(div, source.slice(cursor), doc);
  return div;
}
