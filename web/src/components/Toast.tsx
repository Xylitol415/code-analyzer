import { useCallback, useState } from "react";

export interface ToastItem {
  id: number;
  type: "success" | "error";
  text: string;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((type: "success" | "error", text: string) => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p, { id, type, text }]);
    window.setTimeout(() => {
      setToasts((p) => p.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return { toasts, show };
}

export function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed top-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
            t.type === "success" ? "bg-emerald-600" : "bg-red-600"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
