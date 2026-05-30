import { useToastStore } from '../lib/toast';
import { Toast } from './ui';

/**
 * Renders the live toast queue. Mounted once in the Shell. Anchored to the
 * window's bottom-right, above the chrome; `pointer-events-none` on the stack
 * lets clicks pass through the gaps while each toast stays interactive.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-3 right-3 z-50 flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast
            title={t.title}
            description={t.description}
            variant={t.variant}
            onDismiss={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  );
}
