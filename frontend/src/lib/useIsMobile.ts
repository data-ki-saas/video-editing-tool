"use client";

/**
 * Whether this session should get the touch-first mobile editor
 * (components/editor-mobile/MobileEditor.tsx) instead of the desktop
 * ThreePaneEditor, which hard-assumes a mouse and a >=1500px viewport (see
 * that file's own module comment) with no responsive fallback.
 *
 * `isReady` stays false until the first client-side check has actually run
 * -- matchMedia can't be read during SSR/first paint, so the caller (see
 * app/dashboard/[projectId]/page.tsx) should keep showing a loader rather
 * than picking either editor while this is false, avoiding a flash of the
 * wrong one.
 */
import { useEffect, useState } from "react";

const MOBILE_MEDIA_QUERY = "(pointer: coarse) and (max-width: 900px)";

export function useIsMobile(): { isMobile: boolean; isReady: boolean } {
  const [state, setState] = useState({ isMobile: false, isReady: false });

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first client-side read of matchMedia, can't happen any earlier
    setState({ isMobile: mql.matches, isReady: true });

    function handleChange(e: MediaQueryListEvent) {
      setState((prev) => ({ ...prev, isMobile: e.matches }));
    }
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return state;
}
