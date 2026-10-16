"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GUEST_COOKIE, GUEST_MAX_AGE } from "./guest";

/**
 * "Explore as guest" — latch the guest cookie and drop the visitor into the
 * main feed. httpOnly so only the server (proxy + server components) reads it;
 * the client never needs to.
 */
export async function continueAsGuest() {
  const store = await cookies();
  store.set(GUEST_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_MAX_AGE,
  });
  redirect("/");
}

