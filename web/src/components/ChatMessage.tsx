import { AnswerFeedback } from "./AnswerFeedback";
import type { ServerConfig } from "../api/client";
import type { ChatMessage as Msg, ToolCall, SkillPreview } from "../types";
import { Markdown } from "./Markdown";
import { CopyReplyButton } from "./CopyReplyButton";
import { BookOpenIcon, ChevronDownIcon, RobotAvatar, StopIcon, UserAvatar } from "./Icons";
import { SkillPreviewCard } from "./SkillPreviewCard";
import { Spinner } from "./Spinner";

export function ChatMessage({ message, onConfirmSkill, config }: { config?: ServerConfig; message: Msg; onConfirmSkill?: (preview: SkillPreview) => Promise<void> }) {
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
  const hasContent = message.content.trim().length > 0;

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
                    <ToolRow key={i} tool={t} stopped={!!message.stopped} streaming={message.streaming} />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {message.source && <p className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700">{message.source !== "generated" && <BookOpenIcon className="h-3.5 w-3.5" />}{{ generated: "模型分析", exact: "已审核知识直接复用", assisted: "参考已审核知识分析" }[message.source]}</p>}

        {hasContent ? (
          <div className="markdown-body">
            <Markdown streaming={message.streaming && !message.stopped}>{message.content}</Markdown>
          </div>
        ) : message.streaming && !message.stopped ? (
          <div className="flex items-center gap-2 py-2 text-sm text-slate-400">
            <Spinner className="h-4 w-4" /> 正在思考…
          </div>
        ) : null}

        {message.skillPreviews?.map((preview) => <SkillPreviewCard key={preview.id} preview={preview}
          confirmed={message.confirmedSkillPreviews?.includes(preview.id)} onConfirm={onConfirmSkill} />)}

        {message.stopped ? (
          <div role="status" className="mt-2 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2.5 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <StopIcon className="h-3.5 w-3.5" />已停止回复
            </span>
            {!hasContent && !message.error && (
              <div className="mt-1 text-slate-500">尚未生成回复内容，你可以重新提问。</div>
            )}
          </div>
        ) : !message.streaming && !hasContent && !message.error && !message.skillPreviews?.length ? (
          <div role="status" className="py-2 text-sm text-slate-500">本次未返回回复内容，请重试。</div>
        ) : null}

        {message.error && <div className="mt-2 text-sm text-red-500">错误：{message.error}</div>}
        {hasContent && !message.streaming && <div className="mt-2 flex flex-wrap items-start gap-1"><CopyReplyButton content={message.content} />
          {config && message.answerId && !message.stopped && !message.error && <AnswerFeedback key={`${config.baseUrl}:${config.token}:${message.answerId}`} config={config} answerId={message.answerId} />}
        </div>}
      </div>
    </div>
  );
}

function ToolRow({ tool, stopped, streaming }: { tool: ToolCall; stopped: boolean; streaming: boolean }) {
  const unfinishedLabel = stopped ? "已停止等待工具结果" : "未收到工具结果";
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      {tool.isError === undefined && (stopped || !streaming) ? (
        <span title={unfinishedLabel} aria-label={unfinishedLabel} className="inline-flex text-slate-400">
          <StopIcon className="h-3 w-3" />
        </span>
      ) : tool.isError === undefined ? (
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
