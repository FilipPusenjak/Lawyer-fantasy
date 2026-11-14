/** Skeleton shown instantly while a league page loads (keeps taps feeling responsive). */
export default function LeagueLoading() {
  return (
    <div className="mx-auto w-full max-w-xl animate-pulse px-4 pb-28 pt-4" aria-busy="true" aria-label="Loading">
      <div className="mb-4 h-6 w-40 rounded-md bg-surface-2" />
      <div className="space-y-3">
        <div className="h-32 rounded-2xl border border-line bg-surface" />
        <div className="h-20 rounded-2xl border border-line bg-surface" />
        <div className="h-48 rounded-2xl border border-line bg-surface" />
      </div>
    </div>
  );
}
