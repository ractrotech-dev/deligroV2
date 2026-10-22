import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/rider_me.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../state/cash.dart';
import '../cash/cash_strip.dart';
import 'availability_card.dart';

/// The rider's home: who they are, and the availability card. Phase 4 adds
/// the day's figures under the card.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(meProvider);
            ref.invalidate(cashSummaryProvider);
            // A failed refresh is the offline banner's business, not an error here.
            await ref
                .read(meProvider.future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: [
              if (me != null) _RiderHeader(me: me),
              const SizedBox(height: 16),
              const AvailabilityCard(),
              const CashInHandStrip(),
            ],
          ),
        ),
      ),
    );
  }
}

class _RiderHeader extends StatelessWidget {
  const _RiderHeader({required this.me});

  final RiderMe me;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final name = (me.name ?? '').trim();
    final initial = name.isEmpty ? '' : name.characters.first.toUpperCase();
    return Row(
      children: [
        SizedBox(
          width: 52,
          height: 52,
          child: NetImage(
            url: me.avatarUrl,
            radius: 26,
            fallback: Text(
              initial,
              style: TextStyle(
                color: c.onAccent,
                fontSize: 22,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (name.isNotEmpty)
                Text(
                  name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              if (me.riderCode != null) ...[
                const SizedBox(height: 4),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: c.surface2,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    me.riderCode!,
                    style: dataStyle(context, size: 13),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
