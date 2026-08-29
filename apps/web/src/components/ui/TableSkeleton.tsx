/** Shimmering placeholder rows shown while a table loads. */
export function TableSkeleton({
  rows = 6,
  cols = 6,
  title,
}: {
  rows?: number;
  cols?: number;
  title?: string;
}) {
  return (
    <section className="od-card ui-skel-card" aria-busy="true" aria-label={title ?? "Chargement"}>
      {title && (
        <div className="ui-skel-head">
          <span className="ui-skel ui-skel--title" />
          <span className="ui-skel ui-skel--btn" />
        </div>
      )}
      <div className="ui-skel-table">
        <div className="ui-skel-row ui-skel-row--head">
          {Array.from({ length: cols }).map((_, c) => (
            <span key={c} className="ui-skel ui-skel--cell" style={{ width: `${55 + ((c * 17) % 40)}%` }} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="ui-skel-row">
            {Array.from({ length: cols }).map((_, c) => (
              <span
                key={c}
                className="ui-skel ui-skel--cell"
                style={{ width: `${45 + ((r * 13 + c * 23) % 50)}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
