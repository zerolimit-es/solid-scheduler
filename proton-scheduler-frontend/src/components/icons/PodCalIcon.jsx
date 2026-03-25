/**
 * App Icon · v2.0
 * Shield + date tile + confirmation checkmark.
 * Stroke weight scales with size for optical consistency.
 * Always set aria-label when used standalone.
 */
export function PodCalIcon({
  size = 24,
  className = "",
  "aria-label": ariaLabel,
  ...props
}) {
  // Stroke weights that maintain optical balance at each size
  const outer = size <= 16 ? 2.0 : size <= 20 ? 1.8 : size <= 24 ? 1.5 : size <= 32 ? 1.4 : size <= 48 ? 1.25 : 1.1;
  const tile  = outer * 0.70;
  const check = outer * 1.05;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={className}
      {...props}
    >
      {/* Shield */}
      <path
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
        strokeWidth={outer}
      />
      {/* Date tile — Solid Pod container */}
      <rect x="8" y="8.5" width="8" height="7.5" rx="1.25" strokeWidth={tile} />
      {/* Confirmation checkmark */}
      <polyline points="10,12.25 11.75,14.25 15.5,11.25" strokeWidth={check} />
    </svg>
  );
}
