import type { KeyboardEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitDiffOverviewGeometry } from "./diffOverviewGeometry.js";

export function GitPaneDiffOverview({
  geometry,
  onScrollTo,
}: {
  geometry: GitDiffOverviewGeometry;
  onScrollTo: (top: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const { markers, contentHeight, viewportHeight, scrollTop } = geometry;
  if (markers.length === 0 || contentHeight <= 0 || viewportHeight <= 0) return null;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const currentScroll = Math.max(0, Math.min(maxScroll, scrollTop));
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let target: number;
    switch (event.key) {
      case "ArrowUp":
        target = currentScroll - 40;
        break;
      case "ArrowDown":
        target = currentScroll + 40;
        break;
      case "PageUp":
        target = currentScroll - viewportHeight;
        break;
      case "PageDown":
        target = currentScroll + viewportHeight;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = maxScroll;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    onScrollTo(target);
  };
  const label = intl.formatMessage({ id: "git.review.changeOverview" });

  return (
    <div
      data-git-review-overview
      role="slider"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={maxScroll > 0 ? Math.round((currentScroll / maxScroll) * 100) : 0}
      tabIndex={0}
      title={label}
      className="relative w-5 shrink-0 cursor-pointer select-none border-l border-border bg-background-alt focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-hover"
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        const markerElement =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-git-review-overview-change]")
            : null;
        const markerIndex = markerElement?.dataset.gitReviewOverviewIndex;
        const marker = markerIndex === undefined ? undefined : markers[Number(markerIndex)];
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.height <= 0) return;
        const position = marker
          ? marker.top
          : (Math.max(0, Math.min(rect.height, event.clientY - rect.top)) / rect.height) *
            contentHeight;
        onScrollTo(position - viewportHeight / 2);
      }}
    >
      <div
        data-git-review-overview-viewport
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 border border-foreground-subtlest/40 bg-foreground-subtlest/10"
        style={{
          top: `${(currentScroll / contentHeight) * 100}%`,
          height: `${Math.min(100, (viewportHeight / contentHeight) * 100)}%`,
        }}
      />
      {markers.map((marker, index) => (
        <span
          key={`${marker.kind}:${index}`}
          aria-hidden="true"
          data-git-review-overview-change={marker.kind}
          data-git-review-overview-index={index}
          className={cn(
            "absolute w-1.5",
            marker.kind === "additions" ? "left-0.5 bg-diff-added" : "right-0.5 bg-diff-removed",
          )}
          style={{
            top: `${(marker.top / contentHeight) * 100}%`,
            height: `max(3px, ${((marker.bottom - marker.top) / contentHeight) * 100}%)`,
            maxHeight: `${((contentHeight - marker.top) / contentHeight) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}
