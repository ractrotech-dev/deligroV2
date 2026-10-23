import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/location_service.dart';
import '../../models/support.dart';
import '../../state/support.dart';
import '../../state/providers.dart' show riderKeyProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'attachments.dart';
import 'help_screen.dart' show helpPath, ticketPath;
import 'support_errors.dart';

/// The Help categories in the order of the requirements (§13.3), for when the
/// server's list cannot be read. The server's own list wins when it can.
const defaultTicketCategories = [
  SupportCategory('vendor_not_handing_over', 'Shop not handing over the order'),
  SupportCategory('customer_unreachable', 'Customer unreachable'),
  SupportCategory('incorrect_address', 'Incorrect address'),
  SupportCategory('delivery_payment', 'Delivery payment issue'),
  SupportCategory('cash_reconciliation', 'Cash reconciliation'),
  SupportCategory('accident_emergency', 'Accident or emergency'),
  SupportCategory('app_technical', 'App or technical problem'),
  SupportCategory('other', 'Something else'),
];

const _messageMax = 4000;

/// Raise a ticket: what it is about, the order (optional), the message and up
/// to four photos.
class NewTicketScreen extends ConsumerStatefulWidget {
  const NewTicketScreen({super.key, this.orderId});

  /// An order to link from the start (opened from a delivery).
  final String? orderId;

  @override
  ConsumerState<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends ConsumerState<NewTicketScreen> {
  final _message = TextEditingController();
  String? _category;
  String? _orderId;
  List<File> _photos = [];
  bool _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _orderId = widget.orderId;
    _message.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  bool get _ready => _category != null && _message.text.trim().isNotEmpty && !_sending;

  Future<void> _send() async {
    if (!_ready) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final fix = _category == 'accident_emergency' ? ref.read(latestFixProvider) : null;
    try {
      final made = await ref.read(supportRepoProvider).create(
            category: _category!,
            message: _message.text.trim(),
            orderId: _orderId,
            photos: _photos,
            lat: fix?.lat,
            lng: fix?.lng,
          );
      ref.invalidate(supportOverviewProvider);
      if (!mounted) return;
      showSnack(context, 'Sent to Deligro. Ticket #${made.number}.');
      // The new ticket replaces this form, so Back returns to Help.
      context.pushReplacement(ticketPath(made.id));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = supportErrorText(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final categories = ref.watch(supportOverviewProvider(ref.watch(riderKeyProvider))).value?.categories;
    final list = categories == null || categories.isEmpty ? defaultTicketCategories : categories;
    final orders = ref.watch(recentOrdersProvider(ref.watch(riderKeyProvider))).value ?? const <RecentOrder>[];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Raise a ticket'),
        leading: BackButton(onPressed: () => context.canPop() ? context.pop() : context.go(helpPath)),
      ),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          key: const Key('new-ticket-form'),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
            Text('What is this about?', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            Container(
              decoration: BoxDecoration(
                color: c.surface,
                borderRadius: BorderRadius.circular(radiusBlock),
                border: Border.all(color: c.line),
              ),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (var i = 0; i < list.length; i++) ...[
                    if (i > 0) const Divider(),
                    InkWell(
                      key: Key('category-${list[i].key}'),
                      onTap: () => setState(() => _category = list[i].key),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 52),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          child: Row(
                            children: [
                              Icon(
                                _category == list[i].key
                                    ? Icons.radio_button_checked_rounded
                                    : Icons.radio_button_unchecked_rounded,
                                color: _category == list[i].key ? c.accent : c.muted,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  list[i].label,
                                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (_category == 'accident_emergency') ...[
              const SizedBox(height: 10),
              Container(
                key: const Key('emergency-note'),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.warning_amber_rounded, color: c.deal),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'In danger right now? Use the SOS button on your delivery, or call 112 from your phone, before you write here.',
                        style: TextStyle(color: c.ink, height: 1.35, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            if (orders.isNotEmpty) ...[
              const SizedBox(height: 18),
              Text('Which order? (optional)', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 10),
              DropdownButtonFormField<String?>(
                key: const Key('order-picker'),
                initialValue: orders.any((o) => o.orderId == _orderId) ? _orderId : null,
                isExpanded: true,
                decoration: const InputDecoration(hintText: 'No order'),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('No order')),
                  for (final o in orders)
                    DropdownMenuItem<String?>(
                      value: o.orderId,
                      child: Text(
                        [o.code, if (o.shop != null) o.shop!].join(' · '),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: (v) => setState(() => _orderId = v),
              ),
            ],
            const SizedBox(height: 18),
            Text('Your message', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            TextField(
              key: const Key('ticket-message'),
              controller: _message,
              minLines: 4,
              maxLines: 8,
              maxLength: _messageMax,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(hintText: 'Tell Deligro what happened'),
            ),
            const SizedBox(height: 8),
            PhotoAttachments(photos: _photos, onChanged: (p) => setState(() => _photos = p)),
            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(
                _error!,
                key: const Key('ticket-error'),
                style: TextStyle(color: c.deal, fontWeight: FontWeight.w700),
              ),
            ],
            const SizedBox(height: 18),
            FilledButton(
              key: const Key('send-ticket'),
              onPressed: _ready ? _send : null,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
              child: _sending
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Text('Send to Deligro'),
            ),
          ],
          ),
        ),
      ),
    );
  }
}
