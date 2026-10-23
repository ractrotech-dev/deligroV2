# FLAG_SECURE check on a device (Phase 10, Task 7)

Run 2026-10-23 on emulator `deligro_test` (Android 14), release build of `apps/manager/tool/secure_probe.dart`
(same `MainActivity` and `deligro/secure` channel as the real app; no backend needed).
The probe turns the flag on 3 s after start and off at 25 s.

| Moment | `dumpsys window` flags for the app window | `adb exec-out screencap` |
|---|---|---|
| Launch, flag off | no `SECURE` | works (shows the page) |
| Flag on (~14 s) | `fl=LAYOUT_IN_SCREEN SECURE …` | **empty, 0 bytes** — Android refuses to capture a secure window |
| Flag off again (~36 s) | `fl=LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR …` (no `SECURE`) | works, 63 KB (`secure-flag-off.png`) |
| Flag on, recent-apps view open | `SECURE` | **empty, 0 bytes** — the recents screen is not captured while the flagged app's thumbnail is showing |

No `FATAL` or `E/flutter` lines in logcat during the run.

What this proves: the native half (the flag is set and cleared on the window, screenshots and the recents
thumbnail are blocked). What it does not: the real screens. Which screens ask for the flag is proven by
`apps/manager/test/secure_screens_test.dart` (every pattern matches a real route; the flag follows the
screen on top for taps, deep links, back navigation and tabs). Reaching Finance on a device needs a signed-in
manager and the migrations applied; repeat the dumpsys check there once that exists:

    adb shell dumpsys window windows | grep -iE "Window\{.*com.ractrotech.deligro.manager" -A12 | grep "fl="
