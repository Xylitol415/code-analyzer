import { useState } from "react";
import { Button } from "./Button";
import { RobotAvatar } from "./Icons";

const inputClass =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition";

export interface ConfigBarProps {
  baseUrl: string;
  token: string;
  project: string;
  resume: boolean;
  connecting: boolean;
  connected: boolean;
  modelLabel: string | null;
  onBaseUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onProjectChange: (v: string) => void;
  onResumeChange: (v: boolean) => void;
  onConnect: () => void;
  onNewSession: () => void;
}

export function ConfigBar(props: ConfigBarProps) {
  const [showToken, setShowToken] = useState(false);

  return (
    <div className="border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-1 flex items-center gap-2">
          <RobotAvatar className="h-8 w-8 rounded-lg" />
          <span className="font-semibold text-slate-900">code-analyzer</span>
        </div>

        <input
          className={`${inputClass} w-44`}
          placeholder="后端地址"
          value={props.baseUrl}
          onChange={(e) => props.onBaseUrlChange(e.target.value)}
          disabled={props.connecting}
        />

        <div className="relative">
          <input
            className={`${inputClass} w-44 pr-14`}
            type={showToken ? "text" : "password"}
            placeholder="Token"
            value={props.token}
            onChange={(e) => props.onTokenChange(e.target.value)}
            disabled={props.connecting}
          />
          <button
            type="button"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? "隐藏" : "显示"}
          </button>
        </div>

        <input
          className={`${inputClass} w-56`}
          placeholder="项目路径 或 git URL"
          value={props.project}
          onChange={(e) => props.onProjectChange(e.target.value)}
          disabled={props.connecting}
        />

        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
            checked={props.resume}
            onChange={(e) => props.onResumeChange(e.target.checked)}
            disabled={props.connecting}
          />
          恢复上次会话
        </label>

        <Button
          loading={props.connecting}
          disabled={!props.project.trim() || props.connecting}
          onClick={props.onConnect}
        >
          建会话
        </Button>

        {props.connected && (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              已连接
            </span>
            <span className="text-xs text-slate-500">模型：{props.modelLabel}</span>
            <Button variant="ghost" size="sm" onClick={props.onNewSession}>
              新建会话
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
