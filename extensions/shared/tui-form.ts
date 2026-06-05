const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/y;

export type FormTheme = {
  fg: (name: string, text: string) => string;
  bold: (text: string) => string;
};

export type DatePart = "year" | "month" | "day";

export function fitTuiLine(line: string, width: number): string {
  const limit = Math.max(1, width - 1);
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length && visible < limit;) {
    ANSI_RE.lastIndex = i;
    const ansi = ANSI_RE.exec(line);
    if (ansi) {
      out += ansi[0];
      i = ANSI_RE.lastIndex;
      continue;
    }
    const codePoint = line.codePointAt(i);
    if (codePoint === undefined) break;
    out += String.fromCodePoint(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
    visible += 1;
  }
  return out;
}

export function shiftIsoDate(value: string, part: DatePart, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(Date.UTC(1990, 0, 1));
  if (part === "year") date.setUTCFullYear(date.getUTCFullYear() + delta);
  if (part === "month") date.setUTCMonth(date.getUTCMonth() + delta);
  if (part === "day") date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
