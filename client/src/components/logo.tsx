export function LogoMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-label="Scute" role="img">
      <g stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
        <path d="M16 3.5 L26.8 9.75 V22.25 L16 28.5 L5.2 22.25 V9.75 Z" />
        <path d="M16 12 L19.5 14 V18 L16 20 L12.5 18 V14 Z" />
        <path d="M16 3.5 V12 M26.8 9.75 L19.5 14 M26.8 22.25 L19.5 18 M16 28.5 V20 M5.2 22.25 L12.5 18 M5.2 9.75 L12.5 14" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2 text-primary">
      <LogoMark className="h-6 w-6" />
      <span className="text-base font-semibold tracking-tight text-foreground">Scute</span>
    </div>
  );
}
