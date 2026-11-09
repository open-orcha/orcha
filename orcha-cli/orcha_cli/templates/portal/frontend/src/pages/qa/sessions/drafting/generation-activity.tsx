/** Placeholder cards shown until the first draft streams in. */
export function DraftSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ul className="flex flex-col gap-2" aria-hidden data-draft-skeletons>
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="flex gap-3 rounded-md border border-border bg-panel px-3 py-2.5"
          style={{ opacity: 1 - i * 0.25 }}
        >
          <span className="mt-1 size-3.5 shrink-0 rounded-sm bg-hover" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3 w-2/5 rounded-sm animate-shimmer" />
            <span className="h-2.5 w-4/5 rounded-sm animate-shimmer" />
            <span className="h-2.5 w-3/5 rounded-sm animate-shimmer" />
          </div>
        </li>
      ))}
    </ul>
  );
}
