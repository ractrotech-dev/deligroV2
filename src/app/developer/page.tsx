import { redirect } from "next/navigation";

/**
 * The panel's front door. Until the health overview lands, it is the
 * observability overview, which already opens with the system's state.
 */
export default function DeveloperHome() {
  redirect("/developer/observability");
}
