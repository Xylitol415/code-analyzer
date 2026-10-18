import type { ChatMessage as Msg, ToolCall } from "../types";
import { Markdown } from "./Markdown";
import { ChevronDownIcon, RobotAvatar, UserAvatar } from "./Icons";
import { Spinner } from "./Spinner";

export function ChatMessage({ message }: { message: Msg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end gap-3 px-4 py-3">
        <div className="max-w-[78%] rounded-2xl rounded-tr-sm bg-indigo-600 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-white">
          {message.content}
        </div>
        <UserAvatar className="h-9 w-9 rounded-xl" />
      </div>
    );
  }

  const hasThinking = message.thinking.length > 0;
  const hasTools = message.tools.length > 0;

  return (
    <div className="flex gap-3 px-4 py-3">
      <RobotAvatar className="h-9 w-9 rounded-xl" />
      <div className="max-w-[85%] min-w-0 flex-1">
        {(hasThinking || hasTools) && (
          <div className="mb-2 space-y-1">
            {hasThinking && (
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-1 text-xs text-slate-500 select-none hover:text-slate-700">
                  <ChevronDownIcon className="h-3 w-3 transition-transform group-open:rotate-180" />
                  思考过程（{message.thinking.length} 字）
                </summary>
                <pre className="mt-1.5 rounded-lg bg-slate-100 p-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-500">
                  {message.thinking}
                </pre>
              </details>
            )}
            {hasTools && (
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-1 text-xs text-slate-500 select-none hover:text-slate-700">
                  <ChevronDownIcon className="h-3 w-3 transition-transform group-open:rotate-180" />
                  工具调用（{message.tools.length}）
                </summary>
                <div className="mt-1.5 space-y-1">
                  {message.tools.map((t, i) => (
                    <ToolRow key={i} tool={t} />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {message.content ? (
          <div className="markdown-body">
            <Markdown>{message.content}</Markdown>
          </div>
        ) : message.streaming ? (
          <div className="flex items-center gap-2 py-2 text-sm text-slate-400">
            <Spinner className="h-4 w-4" /> 正在思考…
          </div>
        ) : null}

        {message.error && <div className="mt-2 text-sm text-red-500">错误：{message.error}</div>}
      </div>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolCall }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      {tool.isError === undefined ? (
        <Spinner className="h-3 w-3" />
      ) : tool.isError ? (
        <span className="text-red-500">✗</span>
      ) : (
        <span className="text-emerald-500">✓</span>
      )}
      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">{tool.name}</code>
      <span className="truncate text-slate-400">{JSON.stringify(tool.args ?? {})}</span>
    </div>
  );
}
