import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/duration_text.dart';
import '../../core/format.dart' as fmt;
import '../../core/ist_time.dart';
import '../../core/money.dart';
import '../../models/insights.dart';
import '../../state/history.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../delivery/timeline.dart' show timelineLabel;
import '../earnings/earnings_widgets.dart' show FieldRow, earningsFeature;
import 'history_screen.dart' show outcomeChip;

/// Who cancelled, in words.
String cancelledByText(String? who) => switch (who) {
  'customer' => 'The customer',
  'vendor' => 'The shop',
  'manager' => 'A manager',
  'admin' => 'Deligro support',
  'system' => 'Deligro (automatic)',
  _ => 'Not recorded',
};

/// How the order was handed over, in words.
String proofText(String? proof) => switch (proof) {
  'code' => "The customer's code",
  'photo' => 'A photo of the handover',
  'ops_approved' => 'Approved by ops',
  'staff' => 'Marked delivered by staff',
  'vendor' => 'Handed over by the shop',
  _ => 'Not recorded',
};

/// One finished job in full: times, distance, earning, why it ended, the
/// proof, what was in the order and the timeline. [preview] is the row the
/// rider tapped; it shows while the rest loads.
class HistoryDetailScreen extends ConsumerWidget {
  const HistoryDetailScreen({super.key, required this.orderId, this.preview});

  final String orderId;
  final HistoryItem? preview;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(historyDetailProvider(orderId));
    final showMoney =
        ref.watch(meProvider).value?.feature(earningsFeature) != false;
    return Scaffold(
      appBar: AppBar(title: Text(preview?.code ?? 'Delivery')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(historyDetailProvider(orderId));
            await ref
                .read(historyDetailProvider(orderId).future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: detail.when(
            skipLoadingOnRefresh: true,
            data: (d) => _Body(detail: d, showMoney: showMoney),
            loading: () => preview == null
                ? const Center(child: CircularProgressIndicator())
                : _Body(
                    detail: HistoryDetail(item: preview!),
                    showMoney: showMoney,
                    loadingRest: true,
                  ),
            error: (e, _) {
              final gone = e is ApiException && e.status == 404;
              return ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  SizedBox(
                    height: 420,
                    child: gone
                        ? const EmptyState(
                            icon: Icons.search_off_rounded,
                            title: "This delivery isn't in your history",
                            body: 'It may still be with you, or belong to someone else.',
                          )
                        : ErrorRetry(
                            error: e,
                            onRetry: () =>
                                ref.invalidate(historyDetailProvider(orderId)),
                          ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({
    required this.detail,
    required this.showMoney,
    this.loadingRest = false,
  });

  final HistoryDetail detail;
  final bool showMoney;
  final bool loadingRest;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final it = detail.item;
    final delivered = it.outcome == HistoryOutcome.delivered;
    String at(DateTime? t) => t == null ? '—' : istDayTime(t);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        Panel(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      it.code,
                      style: dataStyle(
                        context,
                        size: 20,
                        weight: FontWeight.w800,
                      ),
                    ),
                  ),
                  outcomeChip(
                    context,
                    it.outcome,
                    key: const Key('detail-outcome'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                it.shop,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                ),
              ),
              if (it.dropArea != null)
                Text(
                  'Dropped at ${it.dropArea}',
                  style: TextStyle(color: c.muted, fontSize: 14),
                ),
              const SizedBox(height: 4),
              Text(
                '${it.itemCount} ${it.itemCount == 1 ? 'item' : 'items'} · order ${money(it.orderValue)}',
                style: TextStyle(color: c.muted, fontSize: 14),
              ),
            ],
          ),
        ),
        const SectionTitle('Times', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
        RowsBox(
          children: [
            FieldRow(label: 'Accepted', value: at(it.acceptedAt)),
            FieldRow(label: 'Picked up', value: at(it.pickedUpAt)),
            if (delivered)
              FieldRow(label: 'Delivered', value: at(it.deliveredAt))
            else
              FieldRow(label: 'Ended', value: at(it.endedAt)),
            if (it.took != null)
              FieldRow(label: 'Took', value: minutesText(it.took!.inMinutes)),
            FieldRow(
              label: 'Distance',
              value: it.distanceKm == null ? '—' : fmt.distance(it.distanceKm!),
            ),
            if (showMoney && it.hasEarning)
              FieldRow(
                label: 'Earning',
                value: money(it.earning!),
                strong: true,
              ),
          ],
        ),
        if (!delivered)
          ..._why(context, it)
        else ...[
          const SectionTitle(
            'Proof',
            padding: EdgeInsets.fromLTRB(4, 20, 4, 8),
          ),
          RowsBox(
            children: [
              FieldRow(label: 'Handed over with', value: proofText(it.proof)),
            ],
          ),
          if (detail.proofPhotoUrl != null) ...[
            const SizedBox(height: 10),
            _ProofPhoto(url: detail.proofPhotoUrl!),
          ],
        ],
        if (loadingRest)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Center(child: CircularProgressIndicator()),
          ),
        if (detail.lines.isNotEmpty) ...[
          const SectionTitle(
            'Items',
            padding: EdgeInsets.fromLTRB(4, 20, 4, 8),
          ),
          Panel(
            key: const Key('detail-items'),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Column(
              children: [
                for (final l in detail.lines)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 34,
                          child: Text(
                            '${l.qty}×',
                            style: dataStyle(
                              context,
                              size: 14,
                              weight: FontWeight.w700,
                            ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            l.name,
                            style: const TextStyle(fontSize: 15),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        if (detail.timeline.isNotEmpty) ...[
          const SectionTitle(
            'Timeline',
            padding: EdgeInsets.fromLTRB(4, 20, 4, 8),
          ),
          Panel(
            key: const Key('detail-timeline'),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Column(
              children: [
                for (final e in ([
                  ...detail.timeline,
                ]..sort((a, b) => a.at.compareTo(b.at))))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 7),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                timelineLabel(e),
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              if ((e.reason ?? '').isNotEmpty)
                                Text(
                                  e.reason!,
                                  style: TextStyle(
                                    color: c.muted,
                                    fontSize: 13.5,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          istClock(e.at),
                          style: dataStyle(
                            context,
                            size: 12.5,
                          ).copyWith(color: c.muted),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _why(BuildContext context, HistoryItem it) {
    return [
      const SectionTitle(
        'What happened',
        padding: EdgeInsets.fromLTRB(4, 20, 4, 8),
      ),
      RowsBox(
        children: [
          FieldRow(label: 'Reason', value: it.reason ?? 'Not recorded'),
          if (it.outcome == HistoryOutcome.cancelled)
            FieldRow(
              label: 'Cancelled by',
              value: cancelledByText(it.cancelledBy),
            ),
        ],
      ),
    ];
  }
}

/// Field rows in one card with hairlines between them.
class RowsBox extends StatelessWidget {
  const RowsBox({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const Divider(),
            children[i],
          ],
        ],
      ),
    );
  }
}

/// The handover photo, from a link that is good for 10 minutes. Tap for a
/// full-screen view you can zoom.
class _ProofPhoto extends StatelessWidget {
  const _ProofPhoto({required this.url});

  final String url;

  Widget _image({BoxFit fit = BoxFit.cover, Key? key}) => Image.network(
    url,
    key: key,
    fit: fit,
    loadingBuilder: (context, child, progress) => progress == null
        ? child
        : const Center(child: CircularProgressIndicator(strokeWidth: 2)),
    errorBuilder: (context, _, _) => Center(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          "The photo couldn't load. Pull down to try again.",
          textAlign: TextAlign.center,
          style: TextStyle(color: context.colors.muted),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: true,
      label: 'Proof photo. Tap to enlarge',
      excludeSemantics: true,
      child: InkWell(
        key: const Key('proof-photo'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: () => showDialog<void>(
          context: context,
          builder: (dialogContext) => Dialog.fullscreen(
            backgroundColor: Colors.black,
            child: Stack(
              children: [
                Positioned.fill(
                  child: InteractiveViewer(
                    minScale: 1,
                    maxScale: 5,
                    child: _image(
                      fit: BoxFit.contain,
                      key: const Key('proof-photo-large'),
                    ),
                  ),
                ),
                SafeArea(
                  child: Align(
                    alignment: Alignment.topRight,
                    child: IconButton(
                      key: const Key('proof-photo-close'),
                      tooltip: 'Close',
                      color: Colors.white,
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () => Navigator.of(dialogContext).pop(),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(radiusBlock),
          child: Container(
            height: 220,
            color: c.surface2,
            child: _image(key: const Key('proof-photo-image')),
          ),
        ),
      ),
    );
  }
}
