/**
 * The closing mark ---------------------------------------------------------
 *
 * The wordmark set to the width of the viewport, faint, with its bottom third
 * sliced off by the containing block's own edge — the last thing drawn on the
 * marketing surface. The size is in `vw` because the mark is meant to span the
 * screen (eight characters, so a quarter of the width per em); `translate-y`
 * hangs it below the clipping box, and nothing above can be covered: it draws
 * at 7.5% opacity, behind the content (the landing sections, and the login
 * page's header and main, render above it at z-10).
 *
 * Position is absolute, so the parent must be positioned. The landing page
 * places it at the foot of its closing section; the login page uses the same
 * treatment — one definition so the two surfaces cannot drift apart.
 */
export function ClosingMark() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 flex select-none justify-center overflow-hidden"
    >
      <span
        style={{ fontSize: "clamp(72px, 25vw, 560px)" }}
        className="translate-y-[32%] font-bold lowercase leading-none tracking-[-0.03em] text-[var(--home-text)] opacity-[0.075]"
      >
        orqestra
      </span>
    </div>
  );
}
