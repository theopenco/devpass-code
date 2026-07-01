// Block-glyph wordmark. The left half ("devpass") renders muted and the right
// half ("code") renders bright — together they read: devpass code.
const GLYPHS: Record<string, [string, string, string, string]> = {
  c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  d: ["   ▄", "█▀▀█", "█__█", "▀▀▀▀"],
  e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
  v: ["    ", "█__█", "█__█", " ▀▀ "],
  p: ["    ", "█▀▀█", "█__█", "█▀▀▀"],
  a: ["    ", "█▀▀█", "█▀▀█", "█__█"],
  s: ["    ", "█▀▀▀", "▀▀▀█", "▀▀▀▀"],
}

function word(text: string): string[] {
  const rows = ["", "", "", ""]
  text.split("").forEach((ch, index) => {
    const glyph = GLYPHS[ch]
    for (let row = 0; row < 4; row++) {
      rows[row] += (index > 0 ? " " : "") + glyph[row]
    }
  })
  return rows
}

export const logo = {
  left: word("devpass"),
  right: word("code"),
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
