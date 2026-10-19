import type { HTMLAttributes } from "react";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { OmpUiBlock } from "./OmpUiBlock";

/** Build the `code` renderer shared by MarkdownBody and FileViewer's
 * ReactMarkdown configs (the two previously inlined near-identical copies).
 *
 * `inlineClassName` pins inline code to a surface style (MarkdownBody's
 * "markdown-inline-code"); when omitted the incoming className is passed
 * through (FileViewer). `defaultPreview`/`isStreaming` thread the mermaid
 * and code-block props each host needs. */
export function markdownCodeRenderer(options: {
  isStreaming?: boolean;
  defaultPreview?: boolean;
  inlineClassName?: string;
  actionsEnabled?: boolean;
}) {
  // `node` is react-markdown metadata, not a DOM attribute.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return function Code({ className, children, node, ...props }: HTMLAttributes<HTMLElement> & { node?: unknown }) {
    const lang = className?.replace("language-", "").toLowerCase() ?? "";
    const raw = String(children);
    const isBlock = className?.includes("language-") || raw.includes("\n");
    if (isBlock) {
      if (lang === "mermaid") {
        return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={options.isStreaming} defaultPreview={options.defaultPreview} />;
      }
      if (lang === "omp-ui") {
        return <OmpUiBlock code={raw.replace(/\n$/, "")} isStreaming={options.isStreaming} actionsEnabled={options.actionsEnabled} />;
      }
      return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={options.isStreaming} />;
    }
    return (
      <code className={options.inlineClassName ?? className} {...props}>
        {children}
      </code>
    );
  };
}
