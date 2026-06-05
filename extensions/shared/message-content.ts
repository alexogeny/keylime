import { stripSystemReminders } from "./intent";

export function rawTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text as string)
    .join("\n");
}

export function textFromContent(content: unknown): string {
  return stripSystemReminders(rawTextFromContent(content));
}

export function lastUserText(messages: any[]): string {
  const msg = [...messages].reverse().find((m: any) => m?.role === "user");
  return msg ? textFromContent(msg.content) : "";
}

export function promptFromMessages(messages: any[]): string {
  return lastUserText(messages);
}
