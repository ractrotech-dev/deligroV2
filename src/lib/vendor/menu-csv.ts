/** CSV helpers for vendor menu import/export (Excel / Google Sheets friendly). */

const MENU_CSV_HEADERS = [
  "external_id",
  "name",
  "category",
  "price",
  "description",
  "veg",
  "available",
  "popular",
  "bestseller",
  "image_url",
] as const;

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeMenuCsv(
  items: {
    externalId?: string | null;
    name: string;
    category: string;
    price: number;
    description?: string;
    veg: boolean;
    soldOut?: boolean;
    popular?: boolean;
    bestseller?: boolean;
    image?: string;
  }[]
): string {
  const lines = [MENU_CSV_HEADERS.join(",")];
  for (const item of items) {
    lines.push(
      [
        item.externalId ?? "",
        item.name,
        item.category,
        String(item.price),
        item.description ?? "",
        item.veg ? "true" : "false",
        item.soldOut ? "false" : "true",
        item.popular ? "true" : "false",
        item.bestseller ? "true" : "false",
        item.image ?? "",
      ]
        .map((c) => escapeCsvCell(String(c)))
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function downloadTextFile(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
