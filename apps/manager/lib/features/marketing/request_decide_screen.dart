import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/marketing.dart';
import '../../models/offers.dart';
import '../../models/outcome.dart';
import '../../state/marketing.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../offers/offer_fields.dart';
import 'campaign_fields.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';

/// Approving a request (§8.2, §8.4–8.9): the campaign (or offer) it becomes,
/// pre-filled from what the vendor asked for, adjusted by the manager, sent
/// with the decision in one audited step.
class RequestDecideScreen extends ConsumerStatefulWidget {
  const RequestDecideScreen({super.key, required this.bundle});
  final RequestBundle bundle;

  @override
  ConsumerState<RequestDecideScreen> createState() => _RequestDecideScreenState();
}

class _RequestDecideScreenState extends ConsumerState<RequestDecideScreen> {
  late CampaignInput? _campaign;
  late OfferTerms? _offer;
  final _remarks = TextEditingController();
  Map<String, String> _errors = const {};
  String? _refusal;
  bool _busy = false;

  /// One decision, minted when first sent; a retry after a fault resends it.
  RequestDecision? _pending;
  late final Map<String, String> _vendorNames = {r.vendor.id: r.vendor.name};
  late final Map<String, String> _itemNames = {for (final i in r.items) i.id: i.name};

  MarketingRequest get r => widget.bundle.request;

  @override
  void initState() {
    super.initState();
    final kind = r.type.campaignKind;
    _campaign = kind == null
        ? null
        : CampaignInput(
            kind: kind,
            title: r.title,
            zoneId: r.zone.id,
            vendorIds: [r.vendor.id],
            itemIds: kind == CampaignKind.sponsoredProduct ? [for (final i in r.items) i.id] : const [],
            startsAt: _day(r.preferredStart),
            endsAt: _day(r.preferredEnd, end: true),
            budget: r.budget,
            fundedBy: Funding.vendor,
            banner: kind.hasBanner ? BannerFields(headline: r.title.length > 60 ? r.title.substring(0, 60) : r.title) : null,
            requestId: r.id,
          );
    final p = r.proposedOffer;
    _offer = r.type == MarketingType.discountOffer
        ? OfferTerms(
            code: p?.code ?? '',
            label: p?.label,
            kind: p?.kind ?? OfferKind.flat,
            value: p?.value ?? 0,
            minOrder: p?.minOrder ?? 0,
            maxDiscount: p?.maxDiscount,
            startsAt: p?.startsAt,
            expiresAt: p?.expiresAt,
            maxPerCustomer: p?.maxPerCustomer,
            maxRedemptions: p?.maxRedemptions,
            vendorIds: [r.vendor.id],
            itemIds: p?.itemIds ?? [for (final i in r.items) i.id],
            fundedBy: OfferFunding.vendor,
            requestId: r.id,
          )
        : null;
  }

  static DateTime? _day(String? ymd, {bool end = false}) {
    final d = ymd == null ? null : DateTime.tryParse(ymd);
    if (d == null) return null;
    return end ? fromIst(d.year, d.month, d.day, 23, 59) : fromIst(d.year, d.month, d.day);
  }

  @override
  void dispose() {
    _remarks.dispose();
    super.dispose();
  }

  void _edited() {
    _pending = null; // A changed decision is a new decision.
    _refusal = null;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text('Approve #${r.number}'), backgroundColor: c.bg),
      body: ListView(
        key: const Key('decide-form'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
        children: [
          Text('${r.vendor.name} · ${r.type.label}', style: TextStyle(color: c.muted)),
          const SizedBox(height: 4),
          Text(
            _campaign != null
                ? 'Approving creates this campaign. Adjust anything before you approve.'
                : _offer != null
                    ? 'Approving creates this offer, funded by the vendor.'
                    : 'Approve, then move it along by hand as the work happens.',
            style: TextStyle(color: c.ink),
          ),
          if (_campaign != null)
            CampaignFields(
              value: _campaign!,
              errors: _errors,
              lockKind: true,
              lockVendor: _campaign!.kind != CampaignKind.seasonal,
              vendorNames: _vendorNames,
              itemNames: _itemNames,
              onNames: (v, i) => setState(() {
                _vendorNames.addAll(v);
                _itemNames.addAll(i);
              }),
              onChanged: (v) => setState(() {
                _campaign = v;
                _edited();
              }),
            ),
          if (_offer != null)
            OfferFields(
              value: _offer!,
              errors: _errors,
              lockFunding: false,
              lockVendors: true,
              vendorNames: _vendorNames,
              itemNames: _itemNames,
              onNames: (v, i) => setState(() => _itemNames.addAll(i)),
              onChanged: (t) => setState(() {
                _offer = t;
                _edited();
              }),
            ),
          FormSection(title: 'Remarks for the vendor', children: [
            TextField(
              key: const Key('decide-remarks'),
              controller: _remarks,
              maxLines: 3,
              maxLength: 1000,
              decoration: const InputDecoration(labelText: 'Remarks (optional)'),
              onChanged: (_) => _edited(),
            ),
          ]),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_refusal != null)
                Container(
                  key: const Key('decide-refusal'),
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
                  child: Text(_refusal!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
                ),
              FilledButton(
                key: const Key('decide-approve'),
                onPressed: _busy ? null : _approve,
                child: Text(_busy ? 'Approving…' : 'Approve'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _approve() async {
    final errors = {
      ...?_campaign?.problems(),
      if (_offer != null) ...offerProblems(_offer!),
    };
    setState(() => _errors = errors);
    if (errors.isNotEmpty) {
      showSnack(context, 'Fix the highlighted fields first.');
      return;
    }
    _pending ??= RequestDecision.approve(remarks: _remarks.text, campaign: _campaign, offer: _offer);
    await _send(_pending!);
  }

  Future<void> _send(RequestDecision d) async {
    setState(() => _busy = true);
    final Outcome<RequestBundle> out;
    try {
      out = await ref.read(marketingRepoProvider).decide(r.id, d);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(d)),
        ));
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    switch (out) {
      case Applied():
        ref.invalidate(requestDetailProvider(r.id));
        ref.invalidate(requestListProvider);
        ref.invalidate(campaignListProvider);
        showSnack(context, 'Approved. The vendor has been told.');
        Navigator.of(context).pop(true);
      case Refused(:final code, :final field, :final extra):
        _pending = null;
        if (code == 'stale') {
          ref.invalidate(requestDetailProvider(r.id));
          ref.invalidate(requestListProvider);
          showSnack(context, 'Someone else decided this request. Showing the latest.');
          Navigator.of(context).pop(false);
          return;
        }
        setState(() {
          _refusal = marketingRefusal(code, extra);
          _errors = {
            if (code == 'slot_taken') 'slotPosition': 'Slot ${extra['slot'] ?? ''} is taken in those dates',
            if (code == 'code_taken') 'code': 'Already used',
            ?field: 'Check this field',
          };
        });
    }
  }
}
