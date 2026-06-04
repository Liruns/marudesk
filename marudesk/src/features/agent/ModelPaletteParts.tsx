export function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded bg-surface-3 px-1 text-[10px] font-medium leading-[1.5] text-fg-secondary">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}
