import type { Component } from "@earendil-works/pi-tui";
import { fitTuiLine, shiftIsoDate, type DatePart, type FormTheme } from "../shared/tui-form";
import {
  cleanProfileFactValues,
  convertedUnitHint,
  defaultUnit,
  unitKey,
  type ProfileFactField,
  type ProfileFactSection,
  type ProfileFactValues,
} from "./profile-facts.js";

export type ProfileFactFormResult =
  | { action: "done"; values: ProfileFactValues }
  | { action: "back"; dirty: boolean };

type ProfileFactFormOptions = {
  theme: FormTheme;
  section: ProfileFactSection;
  fields: ProfileFactField[];
  values: ProfileFactValues;
  completeness: (values: ProfileFactValues, section: ProfileFactSection) => number;
  done: (result: ProfileFactFormResult) => void;
};

class ProfileFactForm implements Component {
  private selected = 0;
  private datePart: DatePart = "year";
  private dirty = false;

  constructor(private readonly options: ProfileFactFormOptions) {}

  private get theme() { return this.options.theme; }
  private get section() { return this.options.section; }
  private get fields() { return this.options.fields; }
  private get values() { return this.options.values; }

  private dateDisplay(field: ProfileFactField, value: string): string {
    const base = /^\d{4}-\d{2}-\d{2}/.test(value) ? value : "1990-01-01";
    const time = field.kind === "datetime" ? (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})$/.exec(value)?.[1] ?? " HH:mm") : "";
    const [year, month, day] = base.slice(0, 10).split("-");
    const part = (name: DatePart, text: string) => name === this.datePart ? this.theme.fg("accent", this.theme.bold(text)) : text;
    return `${part("year", year)}-${part("month", month)}-${part("day", day)}${time}`;
  }

  private optionDisplay(field: ProfileFactField): string[] {
    const options = field.options ?? [];
    if (!options.length) return [];
    const current = this.values[field.id] ?? "";
    return [`  ${this.theme.fg("dim", "options:")} ${options.map(option => option === current ? this.theme.fg("accent", `[${option || "blank"}]`) : (option || "blank")).join("  ")}`];
  }

  private unitDisplay(field: ProfileFactField): string[] {
    if (!field.unitOptions) return [];
    const current = this.values[unitKey(field)] || defaultUnit(field);
    return [`  ${this.theme.fg("dim", "units:")} ${field.unitOptions.map(unit => unit === current ? this.theme.fg("accent", `[${unit}]`) : unit).join("  ")}`];
  }

  render(width: number): string[] {
    const completeness = this.options.completeness(this.values, this.section);
    const lines = [
      this.theme.fg("accent", this.theme.bold(`Structured profile facts › ${this.section} (${completeness}% complete)`)),
      this.theme.fg("dim", "ENTER preview/save this section · ESC goes back without saving this edit screen"),
      this.theme.fg("dim", "TAB or ↑↓ changes field · type edits · BACKSPACE deletes"),
      this.theme.fg("dim", "Select fields show all choices below: ←/→ cycles · choose other/custom then type for custom text"),
      this.theme.fg("dim", "Unit fields show unit chips below: ←/→ cycles units · Date fields: ←/→ choose Y/M/D, +/- changes value"),
      "",
    ];
    this.fields.forEach((field, index) => {
      const active = index === this.selected;
      const value = this.values[field.id] || "";
      const unit = field.unitOptions ? ` ${this.theme.fg("accent", `[${this.values[unitKey(field)] || defaultUnit(field)}]`)}` : "";
      const hint = field.unitOptions && value ? this.theme.fg("dim", ` ≈ ${convertedUnitHint(value, this.values[unitKey(field)] || defaultUnit(field)) ?? ""}`) : "";
      const shown = (field.kind === "date" || field.kind === "datetime") ? this.dateDisplay(field, value) : (value || this.theme.fg("dim", field.placeholder ?? "optional"));
      const picker = (field.kind === "date" || field.kind === "datetime") && active ? ` (${this.datePart}; +/- changes selected part)` : "";
      const kindHint = field.kind === "select" ? this.theme.fg("dim", " ←/→ choose") : field.unitOptions ? this.theme.fg("dim", " ←/→ unit") : "";
      const prefix = active ? this.theme.fg("accent", "›") : " ";
      lines.push(fitTuiLine(`${prefix} ${field.label}${picker}${unit}: ${shown}${hint}${kindHint}`, width));
      if (active) {
        lines.push(...this.optionDisplay(field), ...this.unitDisplay(field));
        if (field.kind === "text") lines.push(`  ${this.theme.fg("dim", "text input: type the exact value you want saved")}`);
        if (field.kind === "number") lines.push(`  ${this.theme.fg("dim", "number input: type digits/decimal; unit chip is saved with conversion hint when available")}`);
        if (field.kind === "date" || field.kind === "datetime") lines.push(`  ${this.theme.fg("dim", "date picker: highlighted part changes with +/-, move highlight with ←/→")}`);
      }
    });
    lines.push("");
    lines.push(this.theme.fg("warning", "Important: ESC cancels/back-outs. Press ENTER when you want to preview and save."));
    return lines.map(line => fitTuiLine(line, width));
  }

  invalidate() {}

  handleInput(data: string) {
    const field = this.fields[this.selected];
    if (data === "\x1b") return this.options.done({ action: "back", dirty: this.dirty });
    if (data === "\r" || data === "\n") return this.options.done({ action: "done", values: cleanProfileFactValues(this.values) });
    if (data === "\t" || data === "\x1b[B") {
      this.selected = (this.selected + 1) % this.fields.length;
      return;
    }
    if (data === "\x1b[Z" || data === "\x1b[A") {
      this.selected = (this.selected - 1 + this.fields.length) % this.fields.length;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.values[field.id] = (this.values[field.id] ?? "").replace(/^custom: /, "").slice(0, -1);
      if (field.kind === "select" && this.values[field.id]) this.values[field.id] = `custom: ${this.values[field.id]}`;
      this.dirty = true;
      return;
    }
    if (field.unitOptions && (data === "\x1b[C" || data === "\x1b[D")) {
      const options = field.unitOptions;
      const current = Math.max(0, options.indexOf(this.values[unitKey(field)] ?? defaultUnit(field) ?? options[0]));
      const delta = data === "\x1b[C" ? 1 : -1;
      this.values[unitKey(field)] = options[(current + delta + options.length) % options.length];
      this.dirty = true;
      return;
    }
    if (field.kind === "select" && (data === "\x1b[C" || data === "\x1b[D")) {
      const options = field.options ?? [""];
      const current = Math.max(0, options.indexOf(this.values[field.id] ?? ""));
      const delta = data === "\x1b[C" ? 1 : -1;
      this.values[field.id] = options[(current + delta + options.length) % options.length];
      this.dirty = true;
      return;
    }
    if ((field.kind === "date" || field.kind === "datetime") && (data === "\x1b[C" || data === "\x1b[D")) {
      if (data === "\x1b[C") this.datePart = this.datePart === "year" ? "month" : this.datePart === "month" ? "day" : "year";
      else this.datePart = this.datePart === "year" ? "day" : this.datePart === "month" ? "year" : "month";
      return;
    }
    if ((field.kind === "date" || field.kind === "datetime") && (data === "+" || data === "=" || data === "-")) {
      const current = this.values[field.id] ?? "";
      const time = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})$/.exec(current)?.[1] ?? "";
      this.values[field.id] = `${shiftIsoDate(current.slice(0, 10), this.datePart, data === "-" ? -1 : 1)}${time}`;
      this.dirty = true;
      return;
    }
    if (/^[\x20-\x7E]$/.test(data)) {
      if (field.kind === "select") {
        const existing = this.values[field.id] ?? "";
        if (existing === "other / custom" || existing.startsWith("custom: ")) {
          this.values[field.id] = `custom: ${existing.replace(/^custom: |^other \/ custom$/, "")}${data}`;
          this.dirty = true;
        }
        return;
      }
      this.values[field.id] = `${this.values[field.id] ?? ""}${data}`;
      this.dirty = true;
    }
  }
}

export function sectionMenuLabels(sections: readonly ProfileFactSection[], values: ProfileFactValues, completeness: (values: ProfileFactValues, section: ProfileFactSection) => number): string[] {
  return [
    ...sections.map(section => `${section} (${completeness(values, section)}%)`),
    "preview + save all entered facts",
    "cancel without saving",
  ];
}

export function sectionFromLabel(sections: readonly ProfileFactSection[], label: string | undefined): ProfileFactSection | undefined {
  const section = label?.split(" ")[0];
  return sections.find(s => s === section);
}

export async function editProfileFactSection(ctx: any, args: {
  section: ProfileFactSection;
  fields: ProfileFactField[];
  values: ProfileFactValues;
  completeness: (values: ProfileFactValues, section: ProfileFactSection) => number;
}): Promise<ProfileFactValues | null> {
  const before = { ...args.values };
  const result = await ctx.ui.custom<ProfileFactFormResult>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: (result: ProfileFactFormResult) => void) => {
    const form = new ProfileFactForm({ theme, section: args.section, fields: args.fields, values: args.values, completeness: args.completeness, done });
    return {
      render: (width: number) => form.render(width),
      invalidate: () => form.invalidate(),
      handleInput: (data: string) => {
        form.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result.action === "done") return result.values;
  if (!result.dirty) return null;

  const discard = await ctx.ui.confirm(
    "Go back without saving this section?",
    "You changed fields on this screen. Choose Yes to discard those edits and return to the category menu, or No to keep editing.",
  );
  if (discard) {
    for (const key of Object.keys(args.values)) delete args.values[key];
    Object.assign(args.values, before);
    return null;
  }
  return editProfileFactSection(ctx, args);
}
