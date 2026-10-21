import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/cash.dart';
import '../../state/cash.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import 'deposit_card.dart';

/// The list refreshes this often while on screen.
const cashRefresh = Duration(seconds: 30);

/// Cash deposits (§5.14, `manager.cash`): deposits riders declared, waiting
/// for a manager to confirm (which records the hand-over) or dispute;
/// disputes riders raised about a day's count; and what was decided.
class CashScreen extends ConsumerStatefulWidget {
  const CashScreen({super.key});

  @override
  ConsumerState<CashScreen> createState() => _CashScreenState();
}

enum _Tab { deposits, disputes, history }

class _CashScreenState extends ConsumerState<CashScreen> {
  _Tab _tab = _Tab.deposits;

  void _reload() {
    ref.invalidate(depositsProvider);
    ref.invalidate(disputesProvider);
    ref.invalidate(pendingDepositsCountProvider);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final submitted = ref.watch(depositsProvider('submitted'));
    final open = ref.watch(disputesProvider('open'));
    final waiting = submitted.value?.counts.submitted;
    final openCount = open.value?.items.length;

    Widget tab(_Tab t, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('cash-tab-${t.name}'),
            label: Text(label),
            selected: _tab == t,
            onSelected: (_) => setState(() => _tab = t),
          ),
        );

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Cash deposits'), backgroundColor: c.bg),
      body: Polling(
        interval: cashRefresh,
        onTick: _reload,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Row(
                children: [
                  tab(_Tab.deposits, waiting == null ? 'Deposits' : 'Deposits ($waiting)'),
                  tab(_Tab.disputes, openCount == null ? 'Disputes' : 'Disputes ($openCount)'),
                  tab(_Tab.history, 'History'),
                ],
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async => _reload(),
                child: switch (_tab) {
                  _Tab.deposits => _deposits(submitted, 'No deposits are waiting.'),
                  _Tab.disputes => _disputes(open, 'No open disputes.'),
                  _Tab.history => _history(),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _loading(AsyncValue<Object?> v, VoidCallback retry) => v.hasError
      ? ListView(children: [SizedBox(height: 320, child: ErrorRetry(error: v.error!, onRetry: retry))])
      : const Center(child: CircularProgressIndicator());

  Widget _deposits(AsyncValue<CashDepositPage> v, String empty) {
    final data = v.value;
    if (data == null) return _loading(v, _reload);
    if (data.items.isEmpty) return ListView(physics: const AlwaysScrollableScrollPhysics(), children: [EmptyLine(empty)]);
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      itemCount: data.items.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) => DepositCard(deposit: data.items[i], onChanged: _reload),
    );
  }

  Widget _disputes(AsyncValue<CashDisputePage> v, String empty) {
    final data = v.value;
    if (data == null) return _loading(v, _reload);
    if (data.items.isEmpty) return ListView(physics: const AlwaysScrollableScrollPhysics(), children: [EmptyLine(empty)]);
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      itemCount: data.items.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) => DisputeCard(dispute: data.items[i], onChanged: _reload),
    );
  }

  /// Confirmed and disputed deposits and resolved disputes, newest first.
  Widget _history() {
    final confirmed = ref.watch(depositsProvider('confirmed'));
    final disputed = ref.watch(depositsProvider('disputed'));
    final resolved = ref.watch(disputesProvider('resolved'));
    final missing = [confirmed, disputed, resolved].where((v) => !v.hasValue).firstOrNull;
    if (missing != null) return _loading(missing, _reload);
    final deposits = [...confirmed.value!.items, ...disputed.value!.items]
      ..sort((a, b) => (b.decidedAt ?? b.createdAt ?? DateTime(0)).compareTo(a.decidedAt ?? a.createdAt ?? DateTime(0)));
    final disputes = resolved.value!.items;
    if (deposits.isEmpty && disputes.isEmpty) {
      return ListView(physics: const AlwaysScrollableScrollPhysics(), children: const [EmptyLine('Nothing decided yet.')]);
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      children: [
        for (final d in deposits)
          Padding(padding: const EdgeInsets.only(bottom: 10), child: DepositCard(deposit: d)),
        for (final d in disputes)
          Padding(padding: const EdgeInsets.only(bottom: 10), child: DisputeCard(dispute: d)),
      ],
    );
  }
}
