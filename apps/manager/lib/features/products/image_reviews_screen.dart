import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/products.dart';
import '../../state/products.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';
import 'product_tile.dart';

/// Vendor dish photos waiting for a look (§12.7), newest first: a new dish's
/// photo or a changed one, while it is still the photo customers see. "Looks
/// fine" clears it; Flag (as not this dish, or not appropriate, with a note)
/// opens a listing flag and tells the shop. `manager.products.moderate`.
class ImageReviewsScreen extends ConsumerStatefulWidget {
  const ImageReviewsScreen({super.key});

  @override
  ConsumerState<ImageReviewsScreen> createState() => _ImageReviewsScreenState();
}

class _ImageReviewsScreenState extends ConsumerState<ImageReviewsScreen> {
  /// Reviewed here, so they leave the list without a re-read.
  final Set<int> _done = {};
  final List<ImageReviewItem> _more = [];
  int? _nextBefore;
  bool _paged = false;
  bool _loadingMore = false;

  Future<void> _loadMore(int before) async {
    setState(() => _loadingMore = true);
    try {
      final p = await ref.read(productsRepoProvider).imageReviews(before: before);
      if (!mounted) return;
      setState(() {
        _more.addAll(p.items);
        _nextBefore = p.nextBefore;
        _paged = true;
      });
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _review(ImageReviewItem item, {required bool ok}) async {
    String? flagReason;
    String? note;
    if (!ok) {
      final why = await pickOne<ImageFlagReason>(
        context,
        title: "What's wrong with this photo?",
        options: [for (final r in ImageFlagReason.values) (r, r.label, null)],
      );
      if (why == null || !mounted) return;
      note = await showReasonDialog(
        context,
        title: 'Flag: ${why.label}',
        message: 'Tell the shop what to fix. They see this.',
        hint: 'Note',
        submitLabel: 'Flag',
      );
      if (note == null || !mounted) return;
      flagReason = why.wire;
    }
    final id = const Uuid().v4();
    Future<void> send() async {
      try {
        final out = await ref.read(productsRepoProvider).reviewImage(
              changeId: item.changeId,
              outcome: ok ? 'ok' : 'flag',
              flagReason: flagReason,
              note: note,
              clientActionId: id,
            );
        if (!mounted) return;
        switch (out) {
          case Applied():
            setState(() => _done.add(item.changeId));
            showSnack(context, ok ? 'Marked as fine.' : 'Photo flagged. The shop has been told.');
          case Refused(:final code):
            if (code == 'invalid_transition') setState(() => _done.add(item.changeId));
            showSnack(
              context,
              switch (code) {
                'invalid_transition' => 'Someone already reviewed this photo.',
                'not_found' => "This dish isn't in your zones.",
                'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
                'reason_required' => 'Please write a note of at least 3 characters.',
                _ => "That didn't go through ($code).",
              },
            );
        }
      } on ApiException catch (e) {
        if (e.unauthorized) {
          await handleUnauthorized(ref, e);
          return;
        }
        if (!mounted) return;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(e.friendly), action: SnackBarAction(label: 'Retry', onPressed: send)));
      }
    }

    await send();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Photos to review'), backgroundColor: c.bg),
      body: AsyncView(
        value: ref.watch(imageReviewsProvider),
        onRetry: () => ref.invalidate(imageReviewsProvider),
        builder: (first) {
          final rows = [...first.items, ..._more].where((r) => !_done.contains(r.changeId)).toList();
          final next = _paged ? _nextBefore : first.nextBefore;
          return RefreshIndicator(
            onRefresh: () async {
              setState(() {
                _done.clear();
                _more.clear();
                _paged = false;
              });
              ref.invalidate(imageReviewsProvider);
              await ref.read(imageReviewsProvider.future);
            },
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                Text(
                  "New and changed dish photos from shops. Check each one shows the dish and nothing that shouldn't be on the menu.",
                  style: TextStyle(color: c.muted, height: 1.4),
                ),
                const SizedBox(height: 8),
                if (rows.isEmpty) const EmptyLine('No photos waiting for a look.'),
                for (final r in rows) _ReviewCard(item: r, onOk: () => _review(r, ok: true), onFlag: () => _review(r, ok: false)),
                if (next != null)
                  Center(
                    child: TextButton(
                      key: const Key('image-reviews-more'),
                      onPressed: _loadingMore ? null : () => _loadMore(next),
                      child: Text(_loadingMore ? 'Loading…' : 'Show more'),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.item, required this.onOk, required this.onFlag});
  final ImageReviewItem item;
  final VoidCallback onOk;
  final VoidCallback onFlag;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = item.product;
    final when = DateFormat('d MMM, h:mm a').format(item.changedAt.toLocal());
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(radiusBlock), border: Border.all(color: c.line)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ProductThumb(url: item.imageUrl, size: 96, veg: p.veg),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    InkWell(
                      onTap: () => context.push('/more/products/${p.id}'),
                      child: Text(p.name, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15.5)),
                    ),
                    const SizedBox(height: 2),
                    Text(p.vendor.name, style: TextStyle(color: c.muted, fontSize: 13)),
                    const SizedBox(height: 6),
                    Text(
                      item.previousImageUrl == null ? 'New photo · $when' : 'Changed photo · $when',
                      style: TextStyle(color: c.muted, fontSize: 12.5),
                    ),
                    if (item.changedBy != null) Text('By ${item.changedBy!.name}', style: TextStyle(color: c.muted, fontSize: 12.5)),
                  ],
                ),
              ),
              if (item.previousImageUrl != null) ...[
                const SizedBox(width: 8),
                Column(
                  children: [
                    ProductThumb(url: item.previousImageUrl, size: 48, veg: p.veg),
                    Text('Before', style: TextStyle(color: c.muted, fontSize: 11)),
                  ],
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                key: Key('image-review-flag-${item.changeId}'),
                onPressed: onFlag,
                icon: const Icon(Icons.flag_outlined, size: 18),
                label: const Text('Flag'),
              ),
              FilledButton.icon(
                key: Key('image-review-ok-${item.changeId}'),
                onPressed: onOk,
                icon: const Icon(Icons.check, size: 18),
                label: const Text('Looks fine'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
