import { createContext, memo, useContext, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { MermaidDiagram } from "./MermaidDiagram";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// 按需注册常用语言（依赖已覆盖：jsx→markup+javascript，tsx→typescript+jsx，php→markup-templating）
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import markupTemplating from "react-syntax-highlighter/dist/esm/languages/prism/markup-templating";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";

const register = SyntaxHighlighter.registerLanguage.bind(SyntaxHighlighter);
register("markup", markup);
register("markup-templating", markupTemplating);
register("javascript", javascript);
register("typescript", typescript);
register("jsx", jsx);
register("tsx", tsx);
register("css", css);
register("python", python);
register("java", java);
register("go", go);
register("rust", rust);
register("c", c);
register("cpp", cpp);
register("csharp", csharp);
register("kotlin", kotlin);
register("swift", swift);
register("php", php);
register("ruby", ruby);
register("bash", bash);
register("powershell", powershell);
register("sql", sql);
register("json", json);
register("yaml", yaml);
register("toml", toml);
register("ini", ini);
register("markdown", markdown);
register("diff", diff);

const MarkdownContext = createContext({ source: "", streaming: false });

// The parser's node range includes the original fences, unlike code.children.
// Check the closing marker so a syntactically valid but unfinished stream is not
// rendered early. Prefixes account for fenced blocks in lists and blockquotes.
function hasClosingFence(raw: string): boolean {
  const lines = raw.trimEnd().split(/\r?\n/);
  if (lines.length < 2) return false;
  const opening = /^(`{3,}|~{3,})/.exec(lines[0]);
  const closing = /^(?:[ \t]*>[ \t]*)*[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!);
  return !!opening && !!closing && opening[1][0] === closing[1][0] && closing[1].length >= opening[1].length;
}

// Stable component identities keep completed diagrams mounted as later tokens arrive.
const components: Components = {
  pre({ node, children, ...rest }) {
    const { source, streaming } = useContext(MarkdownContext);
    const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
    if (code?.type === "element" && Array.isArray(code.properties.className) &&
        code.properties.className.some((name) => String(name).toLowerCase() === "language-mermaid")) {
      const definition = code.children.map((child) => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");
      const raw = source.slice(node?.position?.start.offset, node?.position?.end.offset);
      return <MermaidDiagram source={definition} complete={hasClosingFence(raw)} streaming={streaming} />;
    }
    return <pre {...rest}>{children}</pre>;
  },
  code({ node: _node, className, children, ...rest }) {
    const match = /language-([\w+-]+)/.exec(className || "");
    if (match) {
      return (
        <SyntaxHighlighter language={match[1]} style={oneDark} PreTag="div">
          {String(children).replace(/\n$/, "")}
        </SyntaxHighlighter>
      );
    }
    return <code className={className} {...rest}>{children}</code>;
  },
};

export const Markdown = memo(function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const context = useMemo(() => ({ source: children, streaming }), [children, streaming]);
  return (
    <MarkdownContext.Provider value={context}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </MarkdownContext.Provider>
  );
});
