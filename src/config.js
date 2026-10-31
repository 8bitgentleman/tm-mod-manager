// BepInEx 5 `.cfg` reader/editor for the generic settings screen.
//
// BepInEx writes each setting's type, default and allowed values into the file
// as comments, so the file is its own schema:
//
//   ## Description (one or more `##` lines)
//   # Setting type: Single
//   # Default value: 1
//   # Acceptable values: A, B            (enums only)
//   # Acceptable value range: From 0 to 3 (AcceptableValueRange only)
//   # Multiple values can be set ...      ([Flags] enums only)
//   Key = value
//
// A `key = value` with no comment block above it is an *orphan*: a setting the
// plugin no longer binds, which BepInEx keeps rather than deletes. Orphans parse
// with type/default null and are shown as text.
//
// Values are kept exactly as they appear on disk (after BepInEx's own trim).
// BepInEx escapes String values (`\` -> `\\`, newline -> `\n`) when it writes
// them; this module neither escapes nor unescapes, so what you read back is
// what you write.

const SECTION_RE = /^\s*\[(.*)\]\s*$/;
const META_RE = /^#\s*(Setting type|Default value|Acceptable values|Acceptable value range):\s?(.*)$/;
const RANGE_RE = /^From\s+(\S+)\s+to\s+(\S+)\s*$/;
const FLAGS_RE = /^#\s*Multiple values can be set at the same time/;

/** Section names (substrings, case-insensitive) that hold developer knobs. A guess; tune freely. */
export const ADVANCED_SECTIONS = ['Debug', 'Probe', 'FlipProbe', 'Sampler', 'Diagnostics', 'Harness', 'Advanced',
  // Plumbing a player can break things with: CharacterHook's asset-load gate,
  // Radio Big's player address. Seen in the shipped cfgs, 2026-10-31.
  'Gate', 'Server'];

/** Single settings that are developer knobs even inside a player-facing section. A guess; tune freely. */
const ADVANCED_KEY_RE = /verbose|diagnostic|probe|telemetry|harness|dump/i;

const INT_BOUNDS = {
  SByte: [-128n, 127n], Byte: [0n, 255n],
  Int16: [-32768n, 32767n], UInt16: [0n, 65535n],
  Int32: [-2147483648n, 2147483647n], UInt32: [0n, 4294967295n],
  Int64: [-9223372036854775808n, 9223372036854775807n], UInt64: [0n, 18446744073709551615n],
};
const FLOAT_TYPES = new Set(['Single', 'Double', 'Decimal']);

// Split keeping each line's own terminator, so CRLF/LF/mixed files survive.
function splitLines(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) { out.push({ body: text.slice(i), eol: '' }); break; }
    const cr = nl > i && text[nl - 1] === '\r';
    out.push({ body: text.slice(i, cr ? nl - 1 : nl), eol: cr ? '\r\n' : '\n' });
    i = nl + 1;
  }
  return out;
}

function stripBom(s, idx) { return idx === 0 && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

export function parseCfg(text) {
  const sections = [];
  let current = null;
  let pending = [];
  splitLines(text).forEach(({ body: raw }, line) => {
    const body = stripBom(raw, line);
    const trimmed = body.trim();
    if (trimmed === '') { pending = []; return; }
    const sec = SECTION_RE.exec(body);
    if (sec) {
      current = { name: sec[1].trim(), settings: [] };
      sections.push(current);
      pending = [];
      return;
    }
    if (trimmed.startsWith('#')) { pending.push(trimmed); return; }
    const eq = body.indexOf('=');
    if (eq === -1) { pending = []; return; } // junk line; BepInEx skips it too
    if (!current) { current = { name: '', settings: [] }; sections.push(current); }
    current.settings.push({ ...readMeta(pending), key: body.slice(0, eq).trim(), value: body.slice(eq + 1).trim(), line });
    pending = [];
  });
  return { sections };
}

function readMeta(comments) {
  const desc = [];
  const s = { type: null, default: null, description: '' };
  let flags = false;
  for (const c of comments) {
    if (c.startsWith('##')) { desc.push(c.slice(2).replace(/^ /, '')); continue; }
    if (FLAGS_RE.test(c)) { flags = true; continue; }
    const m = META_RE.exec(c);
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === 'Setting type') s.type = v;
    else if (m[1] === 'Default value') s.default = v;
    else if (m[1] === 'Acceptable values') s.choices = v.split(',').map((x) => x.trim()).filter(Boolean);
    else {
      const r = RANGE_RE.exec(v);
      if (r) s.range = { min: Number(r[1]), max: Number(r[2]) };
    }
  }
  s.description = desc.join('\n').trimEnd();
  if (s.choices) s.flags = flags;
  return s;
}

export function control(setting) {
  if (setting.choices) return 'select';
  if (setting.type === 'Boolean') return 'toggle';
  if (FLOAT_TYPES.has(setting.type) || setting.type in INT_BOUNDS) return 'number';
  return 'text';
}

export function isAdvanced(sectionName) {
  const n = String(sectionName).toLowerCase();
  return ADVANCED_SECTIONS.some((w) => n.includes(w.toLowerCase()));
}

export function isAdvancedKey(key) {
  return ADVANCED_KEY_RE.test(String(key));
}

/** Returns an error string, or null when `value` is acceptable for `setting`. */
export function validate(setting, value) {
  if (typeof value !== 'string') return 'value must be a string';
  if (/[\r\n]/.test(value)) return 'value cannot contain a line break';
  if (value !== value.trim()) return 'value has leading or trailing spaces';

  if (setting.choices) {
    const want = setting.choices.map((c) => c.toLowerCase());
    const parts = setting.flags ? value.split(',').map((p) => p.trim()) : [value];
    for (const p of parts) {
      if (!want.includes(p.toLowerCase()))
        return p === '' ? 'empty choice' : `"${p}" is not one of the allowed values`;
    }
    return null;
  }

  const t = setting.type;
  if (t === 'Boolean') return /^(true|false)$/i.test(value) ? null : 'must be true or false';

  let num;
  if (t in INT_BOUNDS) {
    if (!/^[+-]?\d+$/.test(value)) return 'must be a whole number';
    const n = BigInt(value);
    const [lo, hi] = INT_BOUNDS[t];
    if (n < lo || n > hi) return `must be between ${lo} and ${hi}`;
    num = Number(n);
  } else if (FLOAT_TYPES.has(t)) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return 'must be a number';
    num = Number(value);
    if (!Number.isFinite(num)) return 'number is out of range';
  } else {
    return null; // String, KeyCode-without-choices, custom types, orphans: free text
  }
  if (setting.range && (num < setting.range.min || num > setting.range.max))
    return `must be between ${setting.range.min} and ${setting.range.max}`;
  return null;
}

/**
 * Rewrites the `key = value` lines named by `edits` and nothing else: comments,
 * blank lines, order, orphans and each line's own terminator are kept byte for byte.
 */
export function applyEdits(text, edits) {
  if (!edits.length) return text;
  const where = new Map();
  for (const sec of parseCfg(text).sections)
    for (const s of sec.settings) where.set(`${sec.name}\0${s.key}`, s.line); // last wins, as in BepInEx

  const lines = splitLines(text);
  for (const { section, key, value } of edits) {
    const idx = where.get(`${section}\0${key}`);
    if (idx === undefined) throw new Error(`unknown setting [${section}] ${key}`);
    if (typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error(`bad value for [${section}] ${key}: must be a single-line string`);
    const { body } = lines[idx];
    const prefix = /^[^=]*=[ \t]*/.exec(body)[0];
    lines[idx].body = prefix + value;
  }
  return lines.map((l) => l.body + l.eol).join('');
}

/** Edits that put every setting with a known default back to it (unchanged ones and orphans are skipped). */
export function resetEdits(parsed) {
  const edits = [];
  for (const sec of parsed.sections)
    for (const s of sec.settings)
      if (s.default !== null && s.value !== s.default) edits.push({ section: sec.name, key: s.key, value: s.default });
  return edits;
}
