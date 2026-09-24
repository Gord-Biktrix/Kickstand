"use client";

import { useEffect } from "react";
import { linkOpenedAction } from "./actions";

/** Tells staff the customer really saw their link: fires once per page load, after hydration. */
export function LinkOpened({ token }: { token: string }) {
  useEffect(() => {
    linkOpenedAction(token).catch(() => {});
  }, [token]);
  return null;
}
