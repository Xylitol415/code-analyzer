import { useRef, useState } from "react";
import { Button } from "./Button";
import { SendIcon, StopIcon } from "./Icons";

export interface MessageInputProps {
  disabled: boolean;
  streaming: boolean;
  sendingBlocked?: boolean;
  onSend: (text: string, reuse?: "auto" | "bypass") => void;
  onStop: () => void;
}

export function MessageInput(props: MessageInputProps) {
  const [bypass, setBypass] = useState(false);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = value.trim();
    if (!t || props.disabled || props.sendingBlocked || props.streaming) return;
    props.onSend(t, bypass ? "bypass" : "auto");
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  };

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-end gap-2">
        <textarea
          ref={ref}
          aria-label="提问内容"
          rows={1}
          value={value}
          placeholder={
            props.disabled ? "打开右上角「会话配置」并建会话" : "输入问题，Enter 发送，Shift+Enter 换行"
          }
          className="max-h-44 flex-1 resize-none overflow-y-auto rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40 focus:outline-none"
          onChange={(e) => {
            setValue(e.target.value);
            autoResize(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={props.disabled}
        />
        {props.streaming ? (
          <Button variant="danger" onClick={props.onStop}>
            <StopIcon className="h-4 w-4" />
            停止
          </Button>
        ) : (
          <Button onClick={submit} disabled={props.disabled || props.sendingBlocked || !value.trim()}>
            <SendIcon className="h-4 w-4" />
            发送
          </Button>
        )}
      </div>
      <label className="mx-auto mt-2 flex max-w-5xl items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={bypass} onChange={(event) => setBypass(event.target.checked)} disabled={props.disabled || props.streaming} />本次跳过知识复用</label>
    </div>
  );
}
