'use strict';

const CONTROL_CHARS = /[\x00-]/g;
const COLOR_TAG_CHARS = /[\[\]]/g;

function clean(value) {
  return String(value == null ? '' : value)
    .replace(CONTROL_CHARS, '')
    .replace(COLOR_TAG_CHARS, '')
    .trim();
}

function sanitizeLabelPart(value, fallback = '', maxLength = 32) {
  const primary = clean(value);
  const fallbackValue = clean(fallback);
  const out = primary || fallbackValue;
  return out.length > maxLength ? out.slice(0, maxLength) : out;
}

function formatDisplayName({ modVersion, serverVersion, nodeName }) {
  const mod = sanitizeLabelPart(modVersion, '?', 24) || '?';
  const server = sanitizeLabelPart(serverVersion, '?', 24) || '?';
  const node = sanitizeLabelPart(nodeName, '未知节点', 32) || '未知节点';
  return `[green]MDTBBS>LL[orange] M${mod}/S${server}[purple] ${node}`;
}

module.exports = { sanitizeLabelPart, formatDisplayName };
