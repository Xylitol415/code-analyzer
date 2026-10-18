import type { Mermaid } from "mermaid";

let engine: Promise<Mermaid> | undefined;
let renderId = 0;

async function loadEngine(): Promise<Mermaid> {
  engine ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      theme: "base",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      themeVariables: {
        fontSize: "14px",
        primaryColor: "#eef2ff",
        primaryTextColor: "#334155",
        primaryBorderColor: "#a5b4fc",
        lineColor: "#64748b",
        secondaryColor: "#f8fafc",
        tertiaryColor: "#ffffff",
      },
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      secure: ["secure", "securityLevel", "startOnLoad", "htmlLabels", "maxTextSize", "maxEdges", "suppressErrorRendering"],
    });
    return mermaid;
  }).catch((error) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

/** Diagram text is model output: do not apply its directives as site configuration. */
export function diagramDefinition(source: string): string {
  return source
    .replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/%%\{[\s\S]*?\}%%/g, "");
}

export const mermaidRenderer = {
  async render(source: string): Promise<string> {
    if (source.length > 50_000) throw new Error("Diagram exceeds the rendering limit");
    const mermaid = await loadEngine();
    // Mermaid measures SVG text using the DOM. Keep that temporary tree offscreen
    // and remove it even after a parse failure; the displayed result is an image.
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    Object.assign(container.style, { position: "fixed", left: "-100000px", top: "0", visibility: "hidden" });
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(`ca-mermaid-${++renderId}`, diagramDefinition(source), container);
      return svg;
    } finally {
      container.remove();
    }
  },
};
