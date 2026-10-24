"use client";

import { useEffect } from "react";
import { reportNotFound } from "@/lib/obs/client";

/**
 * Tells the error log a page was not found. The server keeps it only when the
 * person is signed in: a broken link inside the app is worth fixing, while
 * signed-out 404s are mostly robots probing.
 */
export function NotFoundReporter() {
  useEffect(() => reportNotFound(), []);
  return null;
}
