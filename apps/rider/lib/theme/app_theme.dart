import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Deligro's colour tokens, copied from src/app/globals.css so the app and the
/// website look like one product. Read them with `context.colors`.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.ink,
    required this.muted,
    required this.line,
    required this.accent,
    required this.accentSoft,
    required this.accentInk,
    required this.onAccent,
    required this.green,
    required this.greenSoft,
    required this.deal,
    required this.dealSoft,
    required this.onGreen,
    required this.onDeal,
    required this.pop,
    required this.popInk,
    required this.blue,
  });

  final Color bg;
  final Color surface;
  final Color surface2;
  final Color ink;
  final Color muted;
  final Color line;
  final Color accent;
  final Color accentSoft;
  final Color accentInk;
  final Color onAccent;
  final Color green;
  final Color greenSoft;
  final Color deal;
  final Color dealSoft;

  /// Text and icons on a solid [green] / [deal] fill. White on the light
  /// theme's deep colours; dark ink on the dark theme's bright ones, where
  /// white would be under 3:1.
  final Color onGreen;
  final Color onDeal;
  final Color pop;
  final Color popInk;
  final Color blue;

  static const light = AppColors(
    bg: Color(0xFFF4F3F0),
    surface: Color(0xFFFCFCFB),
    surface2: Color(0xFFEDECE8),
    ink: Color(0xFF0E1417),
    muted: Color(0xFF52585E),
    line: Color(0xFFDEDCD6),
    accent: Color(0xFFF2660C),
    accentSoft: Color(0xFFFDECDD),
    accentInk: Color(0xFFA4460B),
    onAccent: Color(0xFF2A1305),
    green: Color(0xFF0F7A48),
    greenSoft: Color(0xFFE7F8EF),
    deal: Color(0xFFD1201A),
    dealSoft: Color(0xFFFDECEB),
    onGreen: Color(0xFFFFFFFF),
    onDeal: Color(0xFFFFFFFF),
    pop: Color(0xFFFFC531),
    popInk: Color(0xFF6B4700),
    blue: Color(0xFF2B5F8C),
  );

  static const dark = AppColors(
    bg: Color(0xFF0F1215),
    surface: Color(0xFF171B1F),
    surface2: Color(0xFF21262B),
    ink: Color(0xFFF2F5F4),
    muted: Color(0xFF97A0A6),
    line: Color(0xFF2A3036),
    accent: Color(0xFFFF8534),
    accentSoft: Color(0xB34A2810),
    accentInk: Color(0xFFFFA060),
    onAccent: Color(0xFF2A1305),
    green: Color(0xFF2ED47F),
    greenSoft: Color(0xB3173D2B),
    deal: Color(0xFFFF5C4D),
    dealSoft: Color(0xB34A1B18),
    onGreen: Color(0xFF04210F),
    onDeal: Color(0xFF2A0603),
    pop: Color(0xFFFFCE5C),
    popInk: Color(0xFF4A3000),
    blue: Color(0xFF77B0E0),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(AppColors? other, double t) => t < 0.5 ? this : (other ?? this);
}

extension AppColorsX on BuildContext {
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
}

/// `--radius-block` 0.875rem and `--radius-sheet` 1.25rem.
const radiusBlock = 14.0;
const radiusSheet = 20.0;

/// JetBrains Mono, for numbers (`.text-data`).
TextStyle dataStyle(BuildContext context, {double size = 14, FontWeight weight = FontWeight.w600}) =>
    GoogleFonts.jetBrainsMono(fontSize: size, fontWeight: weight, color: context.colors.ink);

ThemeData buildTheme(Brightness brightness) {
  final c = brightness == Brightness.light ? AppColors.light : AppColors.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: c.accent,
    brightness: brightness,
  ).copyWith(
    primary: c.accent,
    onPrimary: c.onAccent,
    surface: c.surface,
    onSurface: c.ink,
    error: c.deal,
    outline: c.line,
  );
  // Font family rather than GoogleFonts.interTextTheme: google_fonts 9 builds
  // its TextTheme on the separate material_ui package, which is not
  // Flutter's TextTheme type.
  final base = ThemeData(
    brightness: brightness,
    colorScheme: scheme,
    useMaterial3: true,
    fontFamily: GoogleFonts.inter().fontFamily,
  );
  final text = base.textTheme.apply(bodyColor: c.ink, displayColor: c.ink);

  return base.copyWith(
    extensions: [c],
    scaffoldBackgroundColor: c.bg,
    textTheme: text.copyWith(
      // `.text-heading` 20/800 and `.text-display` 800 with tight tracking.
      headlineSmall: text.headlineSmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.4),
      titleLarge: text.titleLarge?.copyWith(fontSize: 20, fontWeight: FontWeight.w800, letterSpacing: -0.3),
      titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w700),
      bodyLarge: text.bodyLarge?.copyWith(fontSize: 15),
      labelSmall: text.labelSmall?.copyWith(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.6,
        color: c.muted,
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      foregroundColor: c.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: GoogleFonts.inter(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink),
    ),
    cardTheme: CardThemeData(
      color: c.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: c.line),
      ),
    ),
    dividerTheme: DividerThemeData(color: c.line, space: 1, thickness: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.accent,
        foregroundColor: c.onAccent,
        disabledBackgroundColor: c.surface2,
        disabledForegroundColor: c.muted,
        minimumSize: const Size(48, 52),
        textStyle: GoogleFonts.inter(fontSize: 16, fontWeight: FontWeight.w800),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.ink,
        minimumSize: const Size(48, 48),
        side: BorderSide(color: c.line),
        textStyle: GoogleFonts.inter(fontSize: 15, fontWeight: FontWeight.w700),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.accentInk,
        textStyle: GoogleFonts.inter(fontWeight: FontWeight.w700),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      hintStyle: TextStyle(color: c.muted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        borderSide: BorderSide(color: c.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        borderSide: BorderSide(color: c.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        borderSide: BorderSide(color: c.accent, width: 1.6),
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: c.surface,
      selectedColor: c.accentSoft,
      side: BorderSide(color: c.line),
      labelStyle: GoogleFonts.inter(fontSize: 13, fontWeight: FontWeight.w600, color: c.ink),
      shape: const StadiumBorder(),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.surface,
      modalBackgroundColor: c.surface,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(radiusSheet)),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      indicatorColor: c.accentSoft,
      surfaceTintColor: Colors.transparent,
      height: 66,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => GoogleFonts.inter(
          fontSize: 11.5,
          fontWeight: s.contains(WidgetState.selected) ? FontWeight.w800 : FontWeight.w600,
          color: s.contains(WidgetState.selected) ? c.accentInk : c.muted,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (s) => IconThemeData(color: s.contains(WidgetState.selected) ? c.accentInk : c.muted),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: c.ink,
      contentTextStyle: GoogleFonts.inter(color: c.bg, fontWeight: FontWeight.w600),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
  );
}
