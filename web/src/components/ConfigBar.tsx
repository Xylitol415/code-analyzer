import { Button, Input, Tag } from "antd";

export interface ConfigBarProps {
  baseUrl: string;
  token: string;
  project: string;
  connecting: boolean;
  sessionId: string | null;
  modelLabel: string | null;
  onBaseUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onProjectChange: (v: string) => void;
  onConnect: () => void;
  onNewSession: () => void;
}

export function ConfigBar(props: ConfigBarProps) {
  return (
    <div className="border-b border-gray-200 bg-white px-4 py-3 flex flex-wrap items-center gap-2">
      <Input
        addonBefore="后端"
        placeholder="http://127.0.0.1:8787"
        value={props.baseUrl}
        onChange={(e) => props.onBaseUrlChange(e.target.value)}
        style={{ width: 210 }}
        disabled={props.connecting}
      />
      <Input.Password
        addonBefore="Token"
        placeholder="Bearer token"
        value={props.token}
        onChange={(e) => props.onTokenChange(e.target.value)}
        style={{ width: 200 }}
        disabled={props.connecting}
      />
      <Input
        addonBefore="项目"
        placeholder="本地路径 或 git URL"
        value={props.project}
        onChange={(e) => props.onProjectChange(e.target.value)}
        style={{ width: 280 }}
        disabled={props.connecting}
      />
      <Button
        type="primary"
        loading={props.connecting}
        onClick={props.onConnect}
        disabled={!props.project.trim() || props.connecting}
      >
        建会话
      </Button>
      {props.sessionId && (
        <>
          <Tag color="green">已连接</Tag>
          <span className="text-gray-500 text-xs">模型：{props.modelLabel}</span>
          <Button size="small" onClick={props.onNewSession}>
            新建会话
          </Button>
        </>
      )}
    </div>
  );
}
