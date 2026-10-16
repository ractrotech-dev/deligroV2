"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const MAX_DIM = 512; // avatars never render larger than this

/**
 * Profile photo control: tap to add one, or — once set — to replace or remove
 * it. Falls back to the user's initials whenever there's no photo.
 *
 * Photos are downscaled to a square JPEG in the browser before they're sent, so
 * a 6 MB phone snap goes up as ~50 KB and never trips the bucket's size limit.
 */
export function ProfileAvatar({
  name,
  initials,
  avatarUrl,
  developer = false,
  readOnly = false,
}: Readonly<{
  name: string;
  initials: string;
  avatarUrl: string | null;
  // App owner / developer — wraps the avatar in a golden ring.
  developer?: boolean;
  /** Shown but not changeable (a rider with "Edit profile" switched off). */
  readOnly?: boolean;
}>) {
  const router = useRouter();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown while the upload is in flight, so the new photo appears instantly.
  const [preview, setPreview] = useState<string | null>(null);

  const shown = preview ?? avatarUrl;

  function pick() {
    setSheet(false);
    inputRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again after a failure
    if (!file) return;

    setError(null);
    setBusy(true);
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);

    try {
      const upload = await toSquareJpeg(file);
      if (!upload) {
        setError(
          t(
            "That image format isn't supported. Try a JPG or PNG.",
            "यह फ़ोटो फ़ॉर्मेट नहीं चलता। जेपीजी या पीएनजी फ़ोटो चुनें।",
          ),
        );
        setPreview(null);
        return;
      }

      const body = new FormData();
      body.append("file", upload);
      const res = await fetch("/api/profile/avatar", { method: "POST", body });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          data.error === "too_large"
            ? t(
                "That photo is too large (5 MB max).",
                "फ़ोटो बहुत बड़ी है (ज़्यादा से ज़्यादा 5 MB)।",
              )
            : data.error === "invalid_type"
              ? t(
                  "That image format isn't supported. Try a JPG or PNG.",
                  "यह फ़ोटो फ़ॉर्मेट नहीं चलता। जेपीजी या पीएनजी फ़ोटो चुनें।",
                )
              : t(
                  "Could not upload the photo. Try again.",
                  "फ़ोटो अपलोड नहीं हो पाई। फिर कोशिश करें।",
                ),
        );
        setPreview(null);
        return;
      }

      router.refresh();
    } catch {
      setError(
        t(
          "Could not upload the photo. Try again.",
          "फ़ोटो अपलोड नहीं हो पाई। फिर कोशिश करें।",
        ),
      );
      setPreview(null);
    } finally {
      setBusy(false);
      URL.revokeObjectURL(localUrl);
    }
  }

  async function remove() {
    setSheet(false);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!res.ok) {
        setError(
          t(
            "Could not remove the photo. Try again.",
            "फ़ोटो हटाई नहीं जा सकी। फिर कोशिश करें।",
          ),
        );
        return;
      }
      setPreview(null);
      router.refresh();
    } catch {
      setError(
        t(
          "Could not remove the photo. Try again.",
          "फ़ोटो हटाई नहीं जा सकी। फिर कोशिश करें।",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (readOnly) return;
          if (avatarUrl) setSheet(true);
          else pick();
        }}
        disabled={busy || readOnly}
        aria-label={
          avatarUrl
            ? t(
                "Change or remove profile photo",
                "प्रोफ़ाइल फ़ोटो बदलें या हटाएं",
              )
            : t("Add a profile photo", "प्रोफ़ाइल फ़ोटो लगाएं")
        }
        className="press relative shrink-0 rounded-full"
      >
        <span
          className={cn(
            "grid size-16 place-items-center overflow-hidden rounded-full bg-accent-soft text-[19px] font-extrabold text-accent-ink",
            // Golden ring for the boss — gold token + a soft gold glow.
            developer &&
              "ring-2 ring-pop ring-offset-2 ring-offset-bg shadow-[0_0_14px_-2px_var(--pop)]",
          )}
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shown}
              alt={name}
              className="h-full w-full object-cover"
            />
          ) : (
            initials
          )}
        </span>
        <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-bg bg-accent text-[var(--on-accent)]">
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Camera className="size-3" />
          )}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        onChange={onFile}
        className="hidden"
      />

      {error ? <p className="mt-2 text-sm text-deal">{error}</p> : null}

      {sheet ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label={t("Close", "बंद करें")}
            onClick={() => setSheet(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-heading">
                {t("Profile photo", "प्रोफ़ाइल फ़ोटो")}
              </h2>
              <button
                type="button"
                onClick={() => setSheet(false)}
                className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="divide-y divide-line">
              <button
                type="button"
                onClick={pick}
                className="press flex w-full items-center gap-3 py-3.5 text-left"
              >
                <ImagePlus className="size-5 shrink-0 text-ink" />
                <span className="flex-1 text-[15px] font-medium">
                  {t("Choose a new photo", "नई फ़ोटो चुनें")}
                </span>
              </button>
              <button
                type="button"
                onClick={remove}
                className="press flex w-full items-center gap-3 py-3.5 text-left text-deal"
              >
                <Trash2 className="size-5 shrink-0" />
                <span className="flex-1 text-[15px] font-medium">
                  {t("Remove photo", "फ़ोटो हटाएं")}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Square-crop + downscale to a JPEG. Returns null when the browser can't decode
 * the file (e.g. an iOS HEIC that slipped past the accept filter), which the
 * caller surfaces as a format error rather than a failed upload.
 */
async function toSquareJpeg(file: File): Promise<File | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(side, MAX_DIM);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Centre-crop to a square, then scale — matches how the avatar is displayed.
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) return null;

  return new File([blob], "avatar.jpg", { type: "image/jpeg" });
}
