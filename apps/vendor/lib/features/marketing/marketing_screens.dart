import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Marketing requests (requirements §6): ask Deligro for a banner, a featured
/// spot, a discount campaign and so on, and follow each through approval.
class MarketingScreen extends ConsumerWidget {
  const MarketingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(marketingProvider);
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: const Text('Marketing requests')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/more/marketing/new'),
        icon: const Icon(Icons.add_rounded),
        label: const Text('New request'),
      ),
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(marketingProvider.future),
          child: value.isEmpty
              ? ListView(
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(40),
                      child: Column(
                        children: [
                          Icon(Icons.campaign_outlined, size: 44, color: c.muted),
                          const SizedBox(height: 12),
                          Text(
                            'Want more customers? Ask Deligro for a banner, a featured spot or a campaign.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: c.muted),
                          ),
                        ],
                      ),
                    ),
                  ],
                )
              : ListView(
                  padding: const EdgeInsets.only(top: 8, bottom: 96),
                  children: [for (final r in value) _RequestTile(r: r)],
                ),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(marketingProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

(Color, Color, String) marketingStatusLook(BuildContext context, String status) {
  final c = context.colors;
  return switch (status) {
    'pending' => (c.deal, c.dealSoft, 'Pending'),
    'approved' => (c.blue, c.surface2, 'Approved'),
    'in_progress' => (c.accentInk, c.accentSoft, 'In progress'),
    'completed' => (c.green, c.greenSoft, 'Completed'),
    'rejected' => (c.deal, c.dealSoft, 'Not approved'),
    _ => (c.muted, c.surface2, 'Cancelled'),
  };
}

class _StatusPill extends StatelessWidget {
  const _StatusPill(this.status);
  final String status;

  @override
  Widget build(BuildContext context) {
    final (fg, bg, word) = marketingStatusLook(context, status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Text(
        word,
        style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700),
      ),
    );
  }
}

class _RequestTile extends StatelessWidget {
  const _RequestTile({required this.r});
  final MarketingRequest r;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        padding: EdgeInsets.zero,
        child: ListTile(
          contentPadding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
          onTap: () => context.push('/more/marketing/${r.id}', extra: r),
          title: Text(r.title, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
            '#${r.number} · ${r.kindLabel} · ${placedAt(r.createdAt)}',
            style: TextStyle(color: c.muted, fontSize: 12.5),
          ),
          trailing: _StatusPill(r.status),
        ),
      ),
    );
  }
}

/// One request: what was asked, Deligro's remarks, and every step so far.
class MarketingDetailScreen extends ConsumerWidget {
  const MarketingDetailScreen({super.key, required this.id, this.initial});

  final String id;
  final MarketingRequest? initial;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = ref.watch(marketingProvider).value?.where((x) => x.id == id).firstOrNull ?? initial;
    if (r == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    final day = DateFormat('d MMM y', 'en_IN');
    return Scaffold(
      appBar: AppBar(title: Text('Request #${r.number}')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(0, 8, 0, 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _StatusPill(r.status),
                const SizedBox(height: 8),
                Text(r.title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                Text(r.kindLabel, style: TextStyle(color: c.muted)),
              ],
            ),
          ),
          if (r.adminRemarks != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Panel(
                tint: r.status == 'rejected' ? c.dealSoft : c.accentSoft,
                child: Text('Deligro: ${r.adminRemarks}', style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
            ),
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.details),
                const SizedBox(height: 10),
                InfoRow(
                  icon: Icons.currency_rupee_rounded,
                  label: 'Budget',
                  value: r.budget == null ? 'Not given' : rupees(r.budget!),
                ),
                InfoRow(
                  icon: Icons.date_range_rounded,
                  label: 'When',
                  value: r.startsOn == null
                      ? 'Whenever suits'
                      : '${day.format(DateTime.parse(r.startsOn!))}${r.endsOn == null ? '' : ' – ${day.format(DateTime.parse(r.endsOn!))}'}',
                ),
              ],
            ),
          ),
          const SectionHeading('Timeline'),
          Panel(
            child: Column(
              children: [
                for (final u in r.updates)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(u.byDeligro ? Icons.support_agent_rounded : Icons.storefront_rounded, color: c.muted),
                    title: Text(
                      marketingStatusLook(context, u.status).$3,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    subtitle: Text(
                      '${u.byDeligro ? 'Deligro' : 'You'} · ${placedAt(u.at)}${u.remarks == null ? '' : '\n${u.remarks}'}',
                      style: TextStyle(color: c.muted, fontSize: 12.5),
                    ),
                  ),
              ],
            ),
          ),
          if (r.status == 'pending')
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
              child: OutlinedButton(
                onPressed: () async {
                  final ok = await runWrite(
                    context,
                    ref,
                    () => ref.read(growthRepoProvider).cancelMarketing(r.id),
                    done: 'Request withdrawn',
                  );
                  if (ok) ref.invalidate(marketingProvider);
                },
                child: const Text('Withdraw request'),
              ),
            ),
        ],
      ),
    );
  }
}

/// Ask Deligro for a campaign.
class NewMarketingScreen extends ConsumerStatefulWidget {
  const NewMarketingScreen({super.key, this.kind});

  final String? kind;

  @override
  ConsumerState<NewMarketingScreen> createState() => _NewMarketingScreenState();
}

class _NewMarketingScreenState extends ConsumerState<NewMarketingScreen> {
  final _form = GlobalKey<FormState>();
  late String _kind = marketingKinds.containsKey(widget.kind) ? widget.kind! : 'banner';
  final _title = TextEditingController();
  final _details = TextEditingController();
  final _budget = TextEditingController();
  DateTimeRange? _range;
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose();
    _details.dispose();
    _budget.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(growthRepoProvider).requestMarketing({
        'kind': _kind,
        'title': _title.text.trim(),
        'details': _details.text.trim(),
        'budget': _budget.text.trim().isEmpty ? null : int.parse(_budget.text.trim()),
        'startsOn': _range == null ? null : isoDate(_range!.start),
        'endsOn': _range == null ? null : isoDate(_range!.end),
      });
      ref.invalidate(marketingProvider);
      messenger.showSnackBar(const SnackBar(content: Text('Request sent. Deligro will get back to you here.')));
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.friendly())));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('Something went wrong. Try again.')));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final day = DateFormat('d MMM', 'en_IN');
    return Scaffold(
      appBar: AppBar(title: const Text('New marketing request')),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: FilledButton(onPressed: _saving ? null : _submit, child: const Text('Send request')),
        ),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            const Text('What would you like?', style: TextStyle(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final e in marketingKinds.entries)
                  ChoiceChip(
                    label: Text(e.value),
                    selected: _kind == e.key,
                    onSelected: (_) => setState(() => _kind = e.key),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _title,
              maxLength: 120,
              decoration: const InputDecoration(labelText: 'Title', hintText: 'e.g. Diwali week banner'),
              validator: (v) => (v ?? '').trim().length < 3 ? 'At least 3 characters' : null,
            ),
            TextFormField(
              controller: _details,
              maxLength: 2000,
              minLines: 4,
              maxLines: 8,
              decoration: const InputDecoration(
                labelText: 'Details',
                hintText: 'What you want, which dishes or offer, anything Deligro should know',
              ),
              validator: (v) => (v ?? '').trim().length < 10 ? 'Tell Deligro a little more (10+ characters)' : null,
            ),
            TextFormField(
              controller: _budget,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Budget (₹, optional)'),
              validator: (v) =>
                  (v ?? '').trim().isEmpty || (int.tryParse(v!.trim()) ?? -1) >= 0 ? null : 'Whole rupees',
            ),
            const SizedBox(height: 8),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.date_range_rounded),
              title: const Text('When (optional)'),
              subtitle: Text(
                _range == null ? 'Whenever suits' : '${day.format(_range!.start)} – ${day.format(_range!.end)}',
              ),
              trailing: _range == null
                  ? const Icon(Icons.edit_calendar_outlined)
                  : IconButton(onPressed: () => setState(() => _range = null), icon: const Icon(Icons.close_rounded)),
              onTap: () async {
                final now = DateTime.now();
                final r = await showDateRangePicker(
                  context: context,
                  firstDate: DateTime(now.year, now.month, now.day),
                  lastDate: now.add(const Duration(days: 365)),
                );
                if (r != null) setState(() => _range = r);
              },
            ),
          ],
        ),
      ),
    );
  }
}
