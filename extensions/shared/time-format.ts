export function ageString(timestamp: number, now = Date.now()): string {
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function daysUntil(timestamp: number, now = Date.now()): number {
  return Math.ceil((timestamp - now) / 86_400_000);
}

export function safeTimestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
