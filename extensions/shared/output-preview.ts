export function headTail(text: string, chars: number, marker = "…"): string {
  if (text.length <= chars) return text;
  const head = Math.ceil(chars * 0.65);
  const tail = Math.floor(chars * 0.35);
  return `${text.slice(0, head)}\n${marker}\n${text.slice(-tail)}`;
}

export function truncateWithMarker(text: string, maxChars: number, marker = "…"): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}\n${marker}`;
}
