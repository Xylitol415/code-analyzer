import { useRef, useState } from "react";
import { Button } from "./Button";
import { SendIcon, StopIcon } from "./Icons";

export interface MessageInputProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function MessageInput(props: MessageInputProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = value.trim();
    if (!t || props.disabled || props.streaming) return;
    props.onSend(t);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  };

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={ref}
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
          <Button onClick={submit} disabled={props.disabled || !value.trim()}>
            <SendIcon className="h-4 w-4" />
            发送
          </Button>
        )}
      </div>
    </div>
  );
}
