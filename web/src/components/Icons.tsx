type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" opacity="0.6" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** AI 机器人头像（indigo→violet 渐变 + 机器人图标） */
export function RobotAvatar({ className = "" }: IconProps) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white ${className}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <rect x="4" y="8" width="16" height="12" rx="2.5" />
        <path d="M12 8V4.5" />
        <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
        <path d="M9 16.5h6" />
      </svg>
    </div>
  );
}

/** 用户人形头像（slate 背景 + 人形图标） */
export function UserAvatar({ className = "" }: IconProps) {
  return (
    <div className={`flex shrink-0 items-center justify-center bg-slate-400 text-white ${className}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21" />
      </svg>
    </div>
  );
}
