export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="38"
      height="38"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 34V17L13 12V34M13 34V8L22 3V34M22 34V18L31 13V34M3 35H37"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M17 14V17M17 21V24M26 22V25M9 23V26"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="34" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}
