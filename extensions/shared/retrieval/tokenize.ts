import type { SearchDocument, TokenizeOptions } from "./types";

export const DEFAULT_STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","up","about","into","through","during","is","are","was","were","be",
  "been","being","have","has","had","do","does","did","will","would","could",
  "should","may","might","this","that","these","those","it","its","as","if",
  "then","than","so","yet","both","each","more","most","other","some","such",
  "no","not","only","same","too","very","can","just","also","get","use","used",
  "using","one","two","three","first","second","new","like","now","how","i",
  "me","my","we","our","you","your","he","she","they","them","their","who",
]);

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
  const minLength = options.minLength ?? 2;
  const normalized = (options.preserveCodeTokens ?? true)
    ? text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._/\\:-]+/g, " ")
    : text;
  return normalized
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= minLength && !stopWords.has(t));
}

export function documentText(doc: SearchDocument): string {
  const fields = Object.entries(doc.fields ?? {})
    .flatMap(([key, value]) => Array.isArray(value) ? [key, ...value] : [key, String(value ?? "")])
    .join(" ");
  return [doc.kind, doc.title, doc.body, fields, ...(doc.tags ?? [])].filter(Boolean).join("\n");
}
