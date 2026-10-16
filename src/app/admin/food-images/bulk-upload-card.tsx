"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FolderUp, Images, Loader2, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldCls } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import {
  isSupportedImageName,
  looksUnnamed,
  tagsFromRelativePath,
  titleFromFilename,
} from "@/lib/images/filename";
import { summarise, useFoodUpload } from "@/stores/food-upload-store";

/**
 * Upload a whole folder of dish photos.
 *
 * The shape of the job is: someone has a folder from a photographer, three
 * hundred pictures, and the library needs them all. So the folder is read, each
 * filename is turned into the dish name it is claiming to be, and the operator
 * gets ONE screen to correct that before anything is sent — after which the
 * uploading itself moves into the background (see `useFoodUpload`) and they can
 * carry on working.
 *
 * The review step is the part that matters. A photo whose name the matcher
 * cannot use is not a small problem here: it is invisible to every shop
 * forever, and nobody re-checks a folder of three hundred. So names that came
 * out of a camera are held back rather than uploaded as "Img 2043", and repeats
 * inside the batch are pointed at rather than sent to collide.
 */

const MAX_BATCH = 500;

interface Staged {
  id: string;
  file: File;
  path: string;
  title: string;
  tags: string[];
  previewUrl: string;
}

export function BulkUploadCard({ disabled }: Readonly<{ disabled: boolean }>) {
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const enqueue = useFoodUpload((s) => s.enqueue);
  const queue = useFoodUpload((s) => s.items);
  const busy = summarise(queue).running;

  // `webkitdirectory` is not in React's attribute types, and setting it through
  // the DOM keeps it out of the render path where React would strip it.
  useEffect(() => {
    const el = folderRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, []);

  // Preview URLs are released as rows go (in `accept`, `drop` and `clear`);
  // this only catches the ones still on screen when the page is left. Keyed on
  // nothing but mount — an effect that depended on `staged` would revoke every
  // preview on each keystroke in a title.
  const stagedRef = useRef<Staged[]>([]);
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);
  useEffect(
    () => () => {
      for (const item of stagedRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    []
  );

  const accept = useCallback(
    (picked: { file: File; path: string }[]) => {
      const images = picked.filter((p) => isSupportedImageName(p.file.name));
      const skipped = picked.length - images.length;

      const capped = images.slice(0, MAX_BATCH);
      const overflow = images.length - capped.length;

      capped.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

      setStaged((prev) => {
        for (const item of prev) URL.revokeObjectURL(item.previewUrl);
        return capped.map((p, index) => ({
          id: `${index}-${p.path}`,
          file: p.file,
          path: p.path,
          title: titleFromFilename(p.file.name),
          tags: tagsFromRelativePath(p.path),
          previewUrl: URL.createObjectURL(p.file),
        }));
      });

      const notes: string[] = [];
      if (skipped > 0) {
        notes.push(
          `${skipped} file${skipped === 1 ? "" : "s"} skipped — only JPG, PNG and WebP go in the library.`
        );
      }
      if (overflow > 0) {
        notes.push(
          `Only the first ${MAX_BATCH} photos were taken; upload these, then drop the folder again for the rest.`
        );
      }
      setNotice(notes.join(" ") || null);
    },
    []
  );

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? []);
    accept(
      list.map((file) => ({
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }))
    );
    event.target.value = "";
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    setReading(true);
    try {
      accept(await readDropped(event.dataTransfer));
    } finally {
      setReading(false);
    }
  };

  const rename = useCallback((id: string, title: string) => {
    setStaged((prev) =>
      prev.map((item) => (item.id === id ? { ...item, title } : item))
    );
  }, []);

  const drop = useCallback((id: string) => {
    setStaged((prev) => {
      const gone = prev.find((item) => item.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  /** Names that appear more than once in this batch — the later ones lose. */
  const repeats = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const item of staged) {
      const key = item.title.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) dupes.add(item.id);
      else seen.add(key);
    }
    return dupes;
  }, [staged]);

  const unnamed = useMemo(
    () => new Set(staged.filter((i) => looksUnnamed(i.title)).map((i) => i.id)),
    [staged]
  );

  const ready = staged.filter((i) => !unnamed.has(i.id) && !repeats.has(i.id));

  const clear = () => {
    for (const item of staged) URL.revokeObjectURL(item.previewUrl);
    setStaged([]);
    setNotice(null);
  };

  const send = () => {
    enqueue(
      ready.map((item) => ({
        file: item.file,
        title: item.title.trim(),
        tags: item.tags,
      }))
    );
    clear();
  };

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-heading text-[15px]">Upload a folder</h2>
          <p className="mt-0.5 text-xs text-muted">
            Every picture at once. The file name becomes the dish name, and the
            folders it sits in become other names for it.
          </p>
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
          dragging ? "border-accent bg-accent/5" : "border-line bg-surface-2/60",
          disabled && "opacity-50"
        )}
      >
        {reading ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Reading the folder…
          </p>
        ) : (
          <>
            <FolderUp className="mx-auto size-6 text-muted" />
            <p className="mt-2 text-[13px] text-muted">
              Drop a folder here, or
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => folderRef.current?.click()}
              >
                <FolderUp className="size-4" /> Choose a folder
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => filesRef.current?.click()}
              >
                <Images className="size-4" /> Choose pictures
              </Button>
            </div>
          </>
        )}
        <input
          ref={folderRef}
          type="file"
          multiple
          className="sr-only"
          onChange={onPick}
        />
        <input
          ref={filesRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={onPick}
        />
      </div>

      {notice ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {notice}
        </p>
      ) : null}

      {busy && staged.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          An upload is running — it keeps going while you work, and you can
          queue another folder on top of it.
        </p>
      ) : null}

      {staged.length > 0 ? (
        <>
          <BatchWarnings unnamed={unnamed.size} repeats={repeats.size} />

          <div className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {staged.map((item) => (
              <StagedRow
                key={item.id}
                id={item.id}
                title={item.title}
                tags={item.tags}
                previewUrl={item.previewUrl}
                unnamed={unnamed.has(item.id)}
                repeat={repeats.has(item.id)}
                onRename={rename}
                onRemove={drop}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || ready.length === 0}
              onClick={send}
            >
              <Upload className="size-4" /> Upload {ready.length} photo
              {ready.length === 1 ? "" : "s"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={clear}>
              <X className="size-4" /> Clear
            </Button>
            <span className="text-[11.5px] text-muted">
              Large pictures are shrunk to fit before they are sent.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Why some rows will not be sent: names the matcher cannot use, and names
 * that appear twice in the batch.
 */
function BatchWarnings({
  unnamed,
  repeats,
}: Readonly<{ unnamed: number; repeats: number }>) {
  return (
    <>
      {unnamed > 0 ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3 py-2 text-[12.5px] leading-snug text-deal">
          <span className="font-semibold">
            {unnamed} photo{unnamed === 1 ? " has" : "s have"} no
            usable name.
          </span>{" "}
          A file called “IMG_2043” tells the matcher nothing, so it would sit
          in the library unreachable. Type the dish name on those rows, or
          leave them — they will be left out of this upload.
        </p>
      ) : null}

      {repeats > 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-snug text-muted">
          <span className="font-semibold text-ink">
            {repeats} repeat{repeats === 1 ? "" : "s"}
          </span>{" "}
          — the same dish name twice in this folder. Only the first of each
          is uploaded; rename the others if they are different dishes.
        </p>
      ) : null}
    </>
  );
}

const StagedRow = memo(function StagedRow({
  id,
  title,
  tags,
  previewUrl,
  unnamed,
  repeat,
  onRename,
  onRemove,
}: {
  id: string;
  title: string;
  tags: string[];
  previewUrl: string;
  unnamed: boolean;
  repeat: boolean;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 p-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL for
          a file that has not been uploaded yet; there is nothing for the image
          pipeline to fetch or optimise. */}
      <img
        src={previewUrl}
        alt=""
        className="size-11 shrink-0 rounded-lg bg-surface-2 object-cover"
      />
      <div className="min-w-0 flex-1">
        <input
          value={title}
          onChange={(e) => onRename(id, e.target.value)}
          placeholder="Name this dish"
          aria-label="Dish name"
          className={cn(
            fieldCls,
            "px-2.5 py-1.5 text-[13px]",
            unnamed && "ring-2 ring-deal/40"
          )}
        />
        {tags.length > 0 || repeat ? (
          <p className="mt-0.5 truncate px-0.5 text-[10.5px] text-muted">
            {repeat ? "Repeat of an earlier row · " : ""}
            {tags.join(" · ")}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onRemove(id)}
        aria-label={`Remove ${title || "photo"}`}
        className="press grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-deal"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
});

/* ------------------------------------------------------------------
 * Reading a dropped folder.
 * ------------------------------------------------------------------ */

/**
 * A drop only hands over `File`s at the top level — the folder itself arrives
 * as a directory entry that has to be walked. `webkitGetAsEntry` is the one
 * interface every browser here supports for that; when it is absent the drop
 * degrades to whatever loose files came with it.
 */
async function readDropped(
  transfer: DataTransfer
): Promise<{ file: File; path: string }[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return Array.from(transfer.files).map((file) => ({ file, path: file.name }));
  }

  const out: { file: File; path: string }[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(
  entry: FileSystemEntry,
  out: { file: File; path: string }[]
): Promise<void> {
  if (out.length >= MAX_BATCH * 2) return; // A stray drop of a home folder.

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    );
    if (file) out.push({ file, path: entry.fullPath.replace(/^\//, "") });
    return;
  }

  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns a page at a time — an empty page means the end.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([]))
    );
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, out);
  }
}
