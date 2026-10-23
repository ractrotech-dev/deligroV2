import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../theme/app_theme.dart';

/// Parses the web's `linear-gradient(135deg,#f6c453,#e8552d)` tints.
Gradient tintGradient(String? css) {
  final hexes = RegExp(r'#([0-9a-fA-F]{6})').allMatches(css ?? '').map(
        (m) => Color(int.parse('FF${m.group(1)}', radix: 16)),
      );
  final colors = hexes.length >= 2
      ? hexes.toList()
      : const [Color(0xFFF6C453), Color(0xFFE8552D)];
  return LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: colors,
  );
}

/// A photo over its tint gradient: the gradient shows while loading and if
/// the image fails, so a tile is never a grey hole (PhotoTile on the web).
class NetImage extends StatelessWidget {
  const NetImage({
    super.key,
    required this.url,
    this.tint,
    this.radius = radiusBlock,
    this.fallback,
  });

  final String? url;
  final String? tint;
  final double radius;
  final Widget? fallback;

  @override
  Widget build(BuildContext context) {
    final backdrop = DecoratedBox(
      decoration: BoxDecoration(gradient: tintGradient(tint)),
      child: Center(child: fallback),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: url == null || url!.isEmpty
          ? backdrop
          : Stack(
              fit: StackFit.expand,
              children: [
                backdrop,
                CachedNetworkImage(
                  imageUrl: url!,
                  fit: BoxFit.cover,
                  fadeInDuration: const Duration(milliseconds: 180),
                  errorWidget: (_, _, _) => const SizedBox.shrink(),
                  placeholder: (_, _) => const SizedBox.shrink(),
                ),
              ],
            ),
    );
  }
}

/// A title with a status chip after it, the chip at the far end. On one line
/// when both fit; with large text or a long title the chip moves under the
/// title instead of running off the edge.
class TitleWithChip extends StatelessWidget {
  const TitleWithChip({super.key, required this.title, required this.chip});

  final Widget title;
  final Widget chip;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          runSpacing: 6,
          children: [title, chip],
        ),
      );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.body,
    this.action,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String? body;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(color: c.accentSoft, shape: BoxShape.circle),
              child: Icon(icon, size: 34, color: c.accentInk),
            ),
            const SizedBox(height: 16),
            Text(title,
                textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
            if (body != null) ...[
              const SizedBox(height: 6),
              Text(body!, textAlign: TextAlign.center, style: TextStyle(color: c.muted)),
            ],
            if (action != null && onAction != null) ...[
              const SizedBox(height: 18),
              FilledButton(onPressed: onAction, child: Text(action!)),
            ],
          ],
        ),
      ),
    );
  }
}

/// A failed load with a retry. Says what went wrong in plain words.
class ErrorRetry extends StatelessWidget {
  const ErrorRetry({super.key, required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => EmptyState(
        icon: Icons.wifi_off_rounded,
        title: 'Couldn\'t load this',
        body: error is ApiException
            ? (error as ApiException).friendly
            : 'Check your connection and try again.',
        action: 'Try again',
        onAction: onRetry,
      );
}

/// AsyncValue → loading spinner / [ErrorRetry] / content.
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({
    super.key,
    required this.value,
    required this.onRetry,
    required this.builder,
    this.loading,
  });

  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) builder;
  final Widget? loading;

  @override
  Widget build(BuildContext context) => value.when(
        skipLoadingOnRefresh: true,
        skipLoadingOnReload: true,
        data: builder,
        loading: () => loading ?? const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorRetry(error: e, onRetry: onRetry),
      );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.trailing, this.padding});
  final String title;
  final Widget? trailing;
  final EdgeInsets? padding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: padding ?? const EdgeInsets.fromLTRB(16, 22, 16, 10),
        child: Row(
          children: [
            Expanded(
              child: Text(title,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 19)),
            ),
            ?trailing,
          ],
        ),
      );
}

void showSnack(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}

/// Rounded surface card used across screens.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.margin});
  final Widget child;
  final EdgeInsets padding;
  final EdgeInsets? margin;

  @override
  Widget build(BuildContext context) => Container(
        margin: margin,
        padding: padding,
        decoration: BoxDecoration(
          color: context.colors.surface,
          borderRadius: BorderRadius.circular(radiusBlock),
          border: Border.all(color: context.colors.line),
        ),
        child: child,
      );
}
