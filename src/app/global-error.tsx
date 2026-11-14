"use client";

/**
 * Last-resort error page (replaces the root layout, so it can't use the global
 * stylesheet). Inline styles match the Game night theme.
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0a0e13",
          color: "#eef3f7",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          textAlign: "center",
        }}
      >
        <title>Something went wrong · Lawyer Fantasy</title>
        <div>
          <h1 style={{ fontSize: 22, margin: 0, textTransform: "uppercase", letterSpacing: "0.02em" }}>Something went wrong</h1>
          <p style={{ color: "#8b9aac", fontSize: 14 }}>Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              minHeight: 44,
              padding: "0 20px",
              borderRadius: 9999,
              border: 0,
              background: "#c6ff3d",
              color: "#0a0e13",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
