// Folder tools the models can call when a student has connected a folder in the browser
// (implemented in lib/folder/browser-fs.ts). Used by the server (sent to the model) and the browser (labels, approval rules).
// browser-fs.ts implements the same names; keep them in sync.

import { describePluginCall, isPluginTool } from "@/lib/plugins/catalog";

export type FolderToolName = "list_files" | "read_file" | "search_files" | "write_file" | "edit_file" | "make_folder" | "move_path" | "delete_path";

export interface ToolDef {
  name: FolderToolName;
  description: string;
  parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] };
  /** true = changes files, so the student must approve it first */
  write: boolean;
}

const p = (description: string, type = "string") => ({ type, description });

export const FOLDER_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "List files and subfolders in the connected folder (or a subfolder). Paths are relative to the connected folder.",
    parameters: { type: "object", properties: { path: p('Subfolder to list, e.g. "notes". Use "." for the top.'), depth: p("How many levels to show, 1-3. Default 1.", "integer") }, required: [] },
    write: false,
  },
  {
    name: "read_file",
    description: "Read a text file (.txt, .md, code, .csv…). .docx files are read as plain text but can't be edited. Long files come back in parts.",
    parameters: { type: "object", properties: { path: p("File path relative to the connected folder."), start_line: p("Line to start from (for long files). Default 1.", "integer") }, required: ["path"] },
    write: false,
  },
  {
    name: "search_files",
    description: "Find text (case-insensitive) in file names and text files. Returns path:line: text for each match.",
    parameters: { type: "object", properties: { query: p("Text to look for."), path: p('Subfolder to search. Default "." (everything).') }, required: ["query"] },
    write: false,
  },
  {
    name: "write_file",
    description: "Create a text file, or replace a whole text file. Prefer edit_file for small changes to existing files. Needs the student's approval.",
    parameters: { type: "object", properties: { path: p("File path relative to the connected folder."), content: p("The complete new file contents.") }, required: ["path", "content"] },
    write: true,
  },
  {
    name: "edit_file",
    description: "Replace one exact piece of text in a text file. old_text must match the file exactly (read it first) and appear once. Needs the student's approval.",
    parameters: { type: "object", properties: { path: p("File path relative to the connected folder."), old_text: p("Exact text to replace (include enough to be unique)."), new_text: p("Replacement text.") }, required: ["path", "old_text", "new_text"] },
    write: true,
  },
  {
    name: "make_folder",
    description: "Create a folder. Needs the student's approval.",
    parameters: { type: "object", properties: { path: p("Folder path relative to the connected folder.") }, required: ["path"] },
    write: true,
  },
  {
    name: "move_path",
    description: "Move or rename a file or folder. Won't overwrite anything. Needs the student's approval.",
    parameters: { type: "object", properties: { from: p("Current path."), to: p("New path.") }, required: ["from", "to"] },
    write: true,
  },
  {
    name: "delete_path",
    description: "Delete a file or folder permanently. Only when the student clearly asked. Always needs the student's approval.",
    parameters: { type: "object", properties: { path: p("Path to delete.") }, required: ["path"] },
    write: true,
  },
];

const BY_NAME = new Map(FOLDER_TOOLS.map((t) => [t.name, t]));

export function isFolderTool(name: unknown): name is FolderToolName {
  return typeof name === "string" && BY_NAME.has(name as FolderToolName);
}

/** Any tool a model may call: folder tools, the Python sandbox, or a plugin (lib/plugins/catalog.ts). */
export const isKnownTool = (name: unknown): boolean => isFolderTool(name) || name === "run_python" || isPluginTool(name);

export function isWriteTool(name: string): boolean {
  return BY_NAME.get(name as FolderToolName)?.write ?? false;
}

/** Short label for the activity list, e.g. "Read notes/week1.md". */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" && args[k] ? String(args[k]) : "");
  switch (name) {
    case "list_files": return `Looked in ${s("path") && s("path") !== "." ? s("path") : "the folder"}`;
    case "read_file": return `Read ${s("path")}`;
    case "search_files": return `Searched for "${s("query")}"`;
    case "write_file": return `Write ${s("path")}`;
    case "edit_file": return `Edit ${s("path")}`;
    case "make_folder": return `Create folder ${s("path")}`;
    case "move_path": return `Move ${s("from")} → ${s("to")}`;
    case "delete_path": return `Delete ${s("path")}`;
    case "run_python": return "Ran Python";
    default: return isPluginTool(name) ? describePluginCall(name, args) : name;
  }
}

/** Limits for one student message ("run"): tool rounds, and how much tool output we resend to the model. */
export const MAX_TOOL_STEPS = 12;
export const MAX_CALLS_PER_STEP = 8;
export const MAX_RESULT_CHARS = 60_000;
export const MAX_RUN_TOOL_CHARS = 150_000;

export function folderPrompt(folderName: string, stepsLeft: number): string {
  return [
    `The student connected a folder from their computer called "${folderName}". You can use the file tools to look at it and, when they ask, change it.`,
    "Rules: only change files when the student asked for it. Read a file before editing it, and prefer edit_file for small changes. " +
      "Changes may need the student's approval (deletes always do): if they decline, don't try the same change again; ask what they'd like instead. " +
      "Paths are relative to the connected folder. When you're done, briefly say what you changed.",
    stepsLeft > 0
      ? `You can make up to ${stepsLeft} more rounds of tool calls for this message.`
      : "You've used all file actions for this message. Don't call tools; summarize what was done and what's left.",
  ].join("\n");
}
