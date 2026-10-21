import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../state/session.dart';
import '../theme/app_theme.dart';

/// Loading, error-with-Retry and data for one AsyncValue — the three states
/// every screen owes the person using it (§18.7). A 401 signs out.
class AsyncView<T> extends ConsumerWidget {
  const AsyncView({super.key, required this.value, required this.onRetry, required this.builder});

  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return value.when(
      skipLoadingOnRefresh: true,
      data: builder,
      loading: () => const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),
      error: (e, _) {
        if (e is ApiException && e.unauthorized) {
          Future.microtask(() => handleUnauthorized(ref, e));
        }
        return ErrorRetry(error: e, onRetry: onRetry);
      },
    );
  }
}

class ErrorRetry extends ConsumerWidget {
  const ErrorRetry({super.key, required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final text = error is ApiException
        ? (error as ApiException).friendly
        : 'Something went wrong. Please try again.';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 36, color: c.muted),
            const SizedBox(height: 10),
            Text(text, textAlign: TextAlign.center, style: TextStyle(color: c.ink, fontSize: 14.5)),
            const SizedBox(height: 14),
            OutlinedButton(onPressed: onRetry, child: Text('Retry')),
          ],
        ),
      ),
    );
  }
}

/// A filtered list that came back with nothing: one quiet line.
class EmptyLine extends StatelessWidget {
  const EmptyLine(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(24),
        child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: context.colors.muted)),
      );
}

/// A small uppercase heading above a group of rows.
class GroupLabel extends StatelessWidget {
  const GroupLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
        child: Text(
          text.toUpperCase(),
          style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: context.colors.muted),
        ),
      );
}

void showSnack(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}
