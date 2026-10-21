import 'package:flutter/material.dart';

/// The website's cold-start splash (src/components/shared/splash-screen.tsx):
/// amber fill, DELIGRO wordmark, company credit and the rider artwork. It sits
/// over the app, then fades out, so the first screen loads underneath it.
class SplashOverlay extends StatefulWidget {
  const SplashOverlay({super.key, required this.child});

  final Widget child;

  @override
  State<SplashOverlay> createState() => _SplashOverlayState();
}

class _SplashOverlayState extends State<SplashOverlay> {
  // Same timing as the website: start fading at 1.45 s, gone by 2 s.
  // The clock starts once the artwork is decoded: on a slow cold start the
  // decode alone can outlast 1.45 s, and the splash would fade before showing.
  bool _hiding = false;
  bool _visible = true;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    Future.wait([
      precacheImage(SplashArt.logo, context),
      precacheImage(SplashArt.art, context),
    ]).whenComplete(() => Future.delayed(const Duration(milliseconds: 1450), () {
          if (mounted) setState(() => _hiding = true);
        }));
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (_visible)
          AnimatedOpacity(
            opacity: _hiding ? 0 : 1,
            duration: const Duration(milliseconds: 550),
            curve: Curves.ease,
            onEnd: () => setState(() => _visible = false),
            child: IgnorePointer(ignoring: _hiding, child: const SplashArt()),
          ),
      ],
    );
  }
}

class SplashArt extends StatelessWidget {
  const SplashArt({super.key});

  /// `.splash` background in src/app/globals.css; the artwork was cut from it.
  static const amber = Color(0xFFE59A01);
  static const logo = AssetImage('assets/brand/splash-logo.jpg');
  static const art = AssetImage('assets/brand/splash-art.jpg');

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Deligro — all in one delivery app',
      child: ColoredBox(
        color: amber,
        child: LayoutBuilder(
          builder: (context, box) {
            final brandWidth = (box.maxWidth * .74).clamp(0.0, 340.0);
            return Stack(
              children: [
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 520),
                      child: Image(image: art,
                          width: box.maxWidth, fit: BoxFit.fitWidth, excludeFromSemantics: true),
                    ),
                  ),
                ),
                // Centred at 46% from the top, like `.splash-brand`.
                Align(
                  alignment: const Alignment(0, -.08),
                  child: SizedBox(
                    width: brandWidth,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Image(image: logo,
                            width: brandWidth, excludeFromSemantics: true),
                        const SizedBox(height: 14),
                        Text(
                          'Phoxera Solutions Private Limited',
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.visible,
                          // Sits above the Navigator, outside any Material,
                          // so take the app font from the theme explicitly.
                          style: TextStyle(
                            fontFamily: Theme.of(context).textTheme.bodyMedium?.fontFamily,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            letterSpacing: .48,
                            color: Color(0xE6FFFFFF),
                            decoration: TextDecoration.none,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
