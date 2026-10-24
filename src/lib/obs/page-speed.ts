/** Which part of the app a page belongs to, from its first path segment (OBSERVABILITY_V2.md, phase 5). */
export function doorOf(path: string): string {
  const first = path.split("/")[1] ?? "";
  switch (first) {
    case "admin": return "admin";
    case "manager": return "manager";
    case "vendor": return "partner";
    case "driver": return "rider";
    case "developer": return "developer";
    case "login": return "sign-in";
    default: return "customer";
  }
}

export const DOORS = ["customer", "partner", "rider", "manager", "admin", "developer", "sign-in"] as const;
