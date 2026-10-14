"use client";

import "katex/dist/katex.min.css";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { hideQuizMarkers } from "@/lib/chat/quiz";
import { hideRememberMarkers } from "@/lib/profile/personal";
import type { Source } from "./answer-text";

// Answers rendered the way ChatGPT / Claude / Gemini / Grok show them: headings, lists, tables, code blocks with a
// language label and Copy, and LaTeX maths. Citation markers ([S1] course files, [W2] web) become small chips.
const tagOf = (s: Pick<Source, "kind" | "n">) => `${s.kind === "web" ? "W" : "S"}${s.n}`;

/** Text → Markdown ready to render: hidden markers removed, \( \) / \[ \] maths turned into $ / $$, citations into
 *  `cite:` links (dropped when final and they point at nothing). Code is left untouched. Pure, for tests. */
export function prepareMarkdown(text: string, sources: Source[] | undefined, final: boolean): string {
  const tags = new Set((sources ?? []).map(tagOf));
  const clean = hideRememberMarkers(hideQuizMarkers(text));
  return clean
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`)
        .replace(/(\s?)\[([SW])(\d+)\](?!\()/g, (_, sp: string, k: string, n: string) => (final && !tags.has(`${k}${n}`) ? "" : `${sp}[${k}${n}](cite:${k}${n})`));
    })
    .join("");
}

function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition hover:bg-surface-300 hover:text-ink">
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? "Copied" : label}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const LANG_NAMES: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", sh: "bash", shell: "bash", cpp: "c++", cs: "c#", md: "markdown", yml: "yaml", tex: "latex" };

function makeComponents(sources: Source[] | undefined): Components {
  const byTag = new Map((sources ?? []).map((s) => [tagOf(s), s]));
  return {
    pre({ children }) {
      const code = Array.isArray(children) ? children[0] : children;
      const cls = (code as { props?: { className?: string } })?.props?.className ?? "";
      const lang = /language-([\w+#-]+)/.exec(cls)?.[1]?.toLowerCase() ?? "";
      return (
        <div className="md-code not-prose">
          <div className="md-code-head">
            <span>{LANG_NAMES[lang] ?? (lang || "code")}</span>
            <CopyButton text={textOf(children).replace(/\n$/, "")} />
          </div>
          <pre>{children}</pre>
        </div>
      );
    },
    a({ href, children }) {
      if (href?.startsWith("cite:")) {
        const tag = href.slice(5);
        const s = byTag.get(tag);
        const web = tag.startsWith("W");
        const label = web ? tag : tag.slice(1);
        return web && s?.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" title={s.label} className="md-cite">{label}</a>
        ) : (
          <sup title={s?.label} className="md-cite">{label}</sup>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    table({ children }) {
      return <div className="md-table"><table>{children}</table></div>;
    },
    input({ checked }) {
      return <input type="checkbox" checked={Boolean(checked)} readOnly className="mr-1.5 translate-y-[2px] accent-[var(--brand)]" />;
    },
  };
}

const urlTransform = (url: string) => (url.startsWith("cite:") ? url : defaultUrlTransform(url));

export const Markdown = memo(function Markdown({ text, sources, final = true, className = "" }: { text: string; sources?: Source[]; final?: boolean; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={makeComponents(sources)}
        urlTransform={urlTransform}
      >
        {prepareMarkdown(text, sources, final)}
      </ReactMarkdown>
    </div>
  );
});

export { CopyButton };

/** Icon-only "Copy" under an answer (copies the Markdown, like the apps do). */
export function CopyAnswer({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={done ? "Copied" : "Copy"} title={done ? "Copied" : "Copy"}
      onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }}
      className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition hover:bg-surface-200 hover:text-ink">
      {done ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
    </button>
  );
}

function CopyIcon({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.5 10.5h-.2A1.3 1.3 0 0 1 2 9.2V3.3C2 2.6 2.6 2 3.3 2h5.9c.7 0 1.3.6 1.3 1.3v.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}
function CheckIcon({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
