"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const subscribe = () => () => {};

// next-themes only knows the real theme after mount (it reads localStorage /
// prefers-color-scheme client-side) — rendering the icon before that would
// either flash the wrong one or mismatch what the server rendered.
// useSyncExternalStore (server snapshot false, client snapshot true) is the
// framework's own tool for exactly this hydration-boundary question, unlike
// a useEffect that just sets state once on mount.
function useHasMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

// A fixed-size placeholder keeps the header's layout stable before mount.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHasMounted();

  if (!mounted) {
    return <div className="size-8" />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
