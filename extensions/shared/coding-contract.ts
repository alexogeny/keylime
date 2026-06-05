export const CODING_CONTRACT = "Inspect narrowly. Mutate only with guarded primitives. Verify only changed behavior.";

export const SOURCE_MUTATION_GUIDELINES = [
  "Inspect narrowly before editing; prefer search/structure/match tools over broad file reads.",
  "For existing source-code edits, use plan_code_replacements/apply_code_replacements.",
  "For new source/config/test/docs/fixtures, use create_file/create_directory.",
  "Do not mutate repo files with raw shell/runtime/git commands; use guarded primitives.",
  "Verify only the changed behavior with run_checks or suggested targeted checks.",
];
