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

type MenuCsvHeader = (typeof MENU_CSV_HEADERS)[number];

export interface ParsedMenuCsvRow {
  line: number;
  externalId: string | null;
  name: string;
  category: string;
  price: number;
  description: string;
  veg: boolean;
  available: boolean;
  popular: boolean;
  bestseller: boolean;
  imageUrl: string | null;
}

export interface MenuCsvParseResult {
  rows: ParsedMenuCsvRow[];
  errors: { line: number; message: string }[];
}

const MAX_IMPORT_ROWS = 500;

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "veg"].includes(v)) return true;
  if (["0", "false", "no", "n", "non-veg", "nonveg"].includes(v)) return false;
  return fallback;
}

/** Minimal RFC4180-ish CSV line split (handles quoted commas). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

export function menuTemplateCsv(): string {
  const header = MENU_CSV_HEADERS.join(",");
  const sample = [
    "item-001",
    "Paneer Butter Masala",
    "Mains",
    "249",
    "Creamy tomato gravy",
    "true",
    "true",
    "true",
    "false",
    "",
  ]
    .map(escapeCsvCell)
    .join(",");
  const sample2 = [
    "item-002",
    "Chicken Biryani",
    "Rice",
    "299",
    "Hyderabadi style",
    "false",
    "true",
    "false",
    "true",
    "",
  ]
    .map(escapeCsvCell)
    .join(",");
  return `${header}\n${sample}\n${sample2}\n`;
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

export function parseMenuCsv(text: string): MenuCsvParseResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((l) => l.trim().length > 0);
  const errors: { line: number; message: string }[] = [];
  const rows: ParsedMenuCsvRow[] = [];

  if (lines.length === 0) {
    return { rows: [], errors: [{ line: 0, message: "File is empty" }] };
  }

  const headerCells = splitCsvLine(lines[0]).map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, "_")
  );
  const indexOf = (key: MenuCsvHeader) => headerCells.indexOf(key);

  if (indexOf("name") < 0 || indexOf("price") < 0) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message: "Header must include at least name and price columns",
        },
      ],
    };
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_IMPORT_ROWS) {
    errors.push({
      line: 0,
      message: `Too many rows (max ${MAX_IMPORT_ROWS}). Extra rows were ignored.`,
    });
  }

  dataLines.slice(0, MAX_IMPORT_ROWS).forEach((line, idx) => {
    const lineNo = idx + 2;
    const cells = splitCsvLine(line);
    const get = (key: MenuCsvHeader) => {
      const i = indexOf(key);
      return i >= 0 ? cells[i] ?? "" : "";
    };

    const name = get("name").trim();
    const priceRaw = get("price").trim();
    const price = Number(priceRaw.replace(/[₹,\s]/g, ""));

    if (!name) {
      errors.push({ line: lineNo, message: "Name is required" });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ line: lineNo, message: `Invalid price “${priceRaw}”` });
      return;
    }

    const category = get("category").trim() || "Popular";
    const externalId = get("external_id").trim() || null;
    const imageUrl = get("image_url").trim() || null;

    rows.push({
      line: lineNo,
      externalId,
      name,
      category,
      price: Math.round(price),
      description: get("description").trim(),
      veg: parseBool(get("veg"), true),
      available: parseBool(get("available"), true),
      popular: parseBool(get("popular"), false),
      bestseller: parseBool(get("bestseller"), false),
      imageUrl,
    });
  });

  return { rows, errors };
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
