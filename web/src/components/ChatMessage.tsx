import { Collapse, Spin } from "antd";
import type { ChatMessage as Msg, ToolCall } from "../types";
import { Markdown } from "./Markdown";

export function ChatMessage({ message }: { message: Msg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[80%] bg-blue-500 text-white rounded-lg px-4 py-2 whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  const hasThinking = message.thinking.length > 0;
  const hasTools = message.tools.length > 0;

  return (
    <div className="px-4 py-2">
      <div className="max-w-[92%]">
        {(hasThinking || hasTools) && (
          <Collapse
            ghost
            size="small"
            className="mb-2"
            items={[
              ...(hasThinking
                ? [
                    {
                      key: "thinking",
                      label: `思考过程（${message.thinking.length} 字）`,
                      children: (
                        <pre className="whitespace-pre-wrap text-gray-500 text-xs m-0">
                          {message.thinking}
                        </pre>
                      ),
                    },
                  ]
                : []),
              ...(hasTools
                ? [
                    {
                      key: "tools",
                      label: `工具调用（${message.tools.length}）`,
                      children: <ToolList tools={message.tools} />,
                    },
                  ]
                : []),
            ]}
          />
        )}

        {message.content ? (
          <div className="markdown-body">
            <Markdown>{message.content}</Markdown>
          </div>
        ) : message.streaming ? (
          <div className="text-gray-400 flex items-center gap-2 py-2">
            <Spin size="small" /> 正在思考…
          </div>
        ) : null}

        {message.error && (
          <div className="text-red-500 text-sm mt-2">错误：{message.error}</div>
        )}
      </div>
    </div>
  );
}

function ToolList({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="space-y-1">
      {tools.map((t, i) => (
        <div key={i} className="text-xs text-gray-600 flex items-center gap-2">
          {t.isError === undefined ? (
            <Spin size="small" />
          ) : t.isError ? (
            <span className="text-red-500">✗</span>
          ) : (
            <span className="text-green-500">✓</span>
          )}
          <code className="bg-gray-100 px-1 rounded">{t.name}</code>
          <span className="text-gray-400 truncate">
            {JSON.stringify(t.args ?? {})}
          </span>
        </div>
      ))}
    </div>
  );
}
