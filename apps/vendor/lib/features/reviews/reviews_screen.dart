import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Customer reviews & insights (requirements §10): the rating, the star
/// breakdown, every review with a public reply, and who your customers are —
/// how many come back, how often, and what they spend. Names only.
class ReviewsScreen extends ConsumerStatefulWidget {
  const ReviewsScreen({super.key});

  @override
  ConsumerState<ReviewsScreen> createState() => _ReviewsScreenState();
}

class _ReviewsScreenState extends ConsumerState<ReviewsScreen> {
  int _days = 90;
  int? _stars;

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(reviewsProvider(_days));
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Reviews & customers'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Reviews'),
              Tab(text: 'Customers'),
            ],
          ),
        ),
        body: switch (async) {
          AsyncData(:final value) => TabBarView(children: [_reviews(value), _customers(value)]),
          AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(reviewsProvider(_days))),
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }

  Widget _reviews(ReviewsState s) {
    final c = context.colors;
    final shown = _stars == null ? s.reviews : s.reviews.where((r) => r.rating == _stars).toList();
    final maxCount = s.stars.values.fold(0, (a, b) => a > b ? a : b);
    return RefreshIndicator(
      onRefresh: () => ref.refresh(reviewsProvider(_days).future),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          const SizedBox(height: 8),
          Panel(
            child: Row(
              children: [
                Column(
                  children: [
                    Text(
                      s.average == null ? '—' : s.average!.toStringAsFixed(1),
                      style: dataStyle(context, size: 34, weight: FontWeight.w800),
                    ),
                    Row(
                      children: [
                        for (var i = 1; i <= 5; i++)
                          Icon(
                            i <= (s.average ?? 0).round() ? Icons.star_rounded : Icons.star_outline_rounded,
                            size: 16,
                            color: const Color(0xFFF2A413),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text('${s.count} ratings', style: TextStyle(color: c.muted, fontSize: 12.5)),
                  ],
                ),
                const SizedBox(width: 20),
                Expanded(
                  child: Column(
                    children: [
                      for (var star = 5; star >= 1; star--)
                        InkWell(
                          onTap: () => setState(() => _stars = _stars == star ? null : star),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Row(
                              children: [
                                SizedBox(
                                  width: 16,
                                  child: Text(
                                    '$star',
                                    style: TextStyle(fontWeight: _stars == star ? FontWeight.w800 : FontWeight.w500),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(99),
                                    child: LinearProgressIndicator(
                                      value: maxCount == 0 ? 0 : (s.stars[star] ?? 0) / maxCount,
                                      minHeight: 7,
                                      backgroundColor: c.surface2,
                                      color: _stars == null || _stars == star ? const Color(0xFFF2A413) : c.line,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                SizedBox(
                                  width: 26,
                                  child: Text(
                                    '${s.stars[star] ?? 0}',
                                    textAlign: TextAlign.end,
                                    style: TextStyle(color: c.muted, fontSize: 12.5),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          SectionHeading(
            _stars == null ? 'All reviews' : '$_stars-star reviews',
            trailing: _stars == null
                ? null
                : TextButton(onPressed: () => setState(() => _stars = null), child: const Text('Show all')),
          ),
          if (shown.isEmpty)
            Padding(
              padding: const EdgeInsets.all(32),
              child: Text(
                'No reviews yet.',
                textAlign: TextAlign.center,
                style: TextStyle(color: c.muted),
              ),
            ),
          for (final r in shown) _ReviewTile(review: r, days: _days),
        ],
      ),
    );
  }

  Widget _customers(ReviewsState s) {
    final c = context.colors;
    final i = s.insights;
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        SizedBox(
          height: 52,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 2),
            children: [
              for (final d in const [30, 90, 180, 365])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(d == 365 ? 'Last year' : 'Last $d days'),
                    selected: _days == d,
                    onSelected: (_) => setState(() => _days = d),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TwoUp(
            children: [
              _Fig('Customers', '${i.customers}'),
              _Fig(
                'Came back',
                '${i.repeatCustomers} · ${i.repeatRate.toStringAsFixed(i.repeatRate % 1 == 0 ? 0 : 1)}%',
              ),
              _Fig('Orders per customer', i.ordersPerCustomer.toStringAsFixed(1)),
              _Fig('Average order', rupees(i.averageOrderValue)),
              _Fig('Days between visits', i.daysBetweenOrders == null ? '—' : i.daysBetweenOrders!.toStringAsFixed(1)),
            ],
          ),
        ),
        if (i.topProducts.isNotEmpty) ...[
          const SectionHeading('Most ordered'),
          Panel(
            child: Column(
              children: [
                for (final p in i.topProducts)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Expanded(child: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis)),
                        Text('${p.qty} sold · ${p.orders} orders', style: TextStyle(color: c.muted, fontSize: 12.5)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        SectionHeading('Your regulars'),
        if (i.topCustomers.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text('No orders in this period.', style: TextStyle(color: c.muted)),
          ),
        for (final (n, t) in i.topCustomers.indexed)
          ListTile(
            leading: CircleAvatar(
              backgroundColor: c.accentSoft,
              child: Text(
                '${n + 1}',
                style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w800),
              ),
            ),
            title: Text(t.name, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(
              '${t.orders} orders · last ${placedAt(t.lastOrderAt)}',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
            trailing: Text(rupees(t.spent), style: dataStyle(context, size: 14, weight: FontWeight.w800)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
          child: Text(
            'Customers are shown by first name and initial only. Their numbers stay private.',
            style: TextStyle(color: c.muted, fontSize: 12.5),
          ),
        ),
      ],
    );
  }
}

class _Fig extends StatelessWidget {
  const _Fig(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: c.muted, fontSize: 12.5)),
          const SizedBox(height: 2),
          FittedBox(
            child: Text(value, style: dataStyle(context, size: 17, weight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }
}

class _ReviewTile extends ConsumerWidget {
  const _ReviewTile({required this.review, required this.days});

  final Review review;
  final int days;

  Future<void> _reply(BuildContext context, WidgetRef ref) async {
    final ctrl = TextEditingController(text: review.reply ?? '');
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.viewInsetsOf(sheet).bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              review.reply == null ? 'Reply publicly' : 'Edit your reply',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            const Text('Everyone who opens your shop can read it.'),
            const SizedBox(height: 12),
            TextField(controller: ctrl, autofocus: true, minLines: 3, maxLines: 6, maxLength: 1000),
            FilledButton(onPressed: () => Navigator.pop(sheet, ctrl.text.trim()), child: const Text('Post reply')),
          ],
        ),
      ),
    );
    if (text == null || text.isEmpty || !context.mounted) return;
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(growthRepoProvider).reply(review.id, text),
      done: 'Reply posted',
    );
    if (ok) ref.invalidate(reviewsProvider(days));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = review;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                for (var i = 1; i <= 5; i++)
                  Icon(
                    i <= r.rating ? Icons.star_rounded : Icons.star_outline_rounded,
                    size: 18,
                    color: const Color(0xFFF2A413),
                  ),
                const SizedBox(width: 8),
                Text(
                  r.orderCode,
                  style: dataStyle(context, size: 12.5, weight: FontWeight.w700).copyWith(color: c.muted),
                ),
                const Spacer(),
                Text(
                  r.createdAt == null ? '' : DateFormat('d MMM', 'en_IN').format(r.createdAt!),
                  style: TextStyle(color: c.muted, fontSize: 12.5),
                ),
              ],
            ),
            if (r.comment != null && r.comment!.trim().isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(r.comment!.trim()),
            ],
            if (r.details.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                children: [
                  for (final d in r.details)
                    Text('${d.label} ${d.value}★', style: TextStyle(color: c.muted, fontSize: 12.5)),
                ],
              ),
            ],
            const SizedBox(height: 8),
            if (r.reply != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(10)),
                child: Text('You: ${r.reply}', style: const TextStyle(fontSize: 13.5)),
              ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: () => _reply(context, ref),
                icon: Icon(r.reply == null ? Icons.reply_rounded : Icons.edit_outlined, size: 18),
                label: Text(r.reply == null ? 'Reply' : 'Edit reply'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
