import { Button, Input } from "antd";
import { useState } from "react";

export interface MessageInputProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function MessageInput(props: MessageInputProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const t = value.trim();
    if (!t || props.disabled || props.streaming) return;
    props.onSend(t);
    setValue("");
  };

  return (
    <div className="border-t border-gray-200 bg-white p-3 flex items-end gap-2">
      <Input.TextArea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          props.disabled ? "请先在上方填写后端/Token/项目并点击「建会话」" : "输入问题，Enter 发送，Shift+Enter 换行"
        }
        autoSize={{ minRows: 1, maxRows: 6 }}
        onPressEnter={(e) => {
          if (!e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={props.disabled}
      />
      {props.streaming ? (
        <Button danger onClick={props.onStop}>
          停止
        </Button>
      ) : (
        <Button type="primary" onClick={submit} disabled={props.disabled || !value.trim()}>
          发送
        </Button>
      )}
    </div>
  );
}
