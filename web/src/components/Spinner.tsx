export function Spinner({
  className = "w-4 h-4",
  light = false,
}: {
  className?: string;
  light?: boolean;
}) {
  return (
    <div
      className={`animate-spin rounded-full border-2 ${
        light ? "border-white/30 border-t-white" : "border-slate-300 border-t-indigo-600"
      } ${className}`}
    />
  );
}
