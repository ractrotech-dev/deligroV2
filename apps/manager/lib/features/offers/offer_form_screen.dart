import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/offers.dart';
import '../../models/outcome.dart';
import '../../state/offers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/reason_dialog.dart';
import 'offer_fields.dart';
import 'offer_labels.dart';

/// Create an offer (§9.1–9.6), or change one: every change carries the
/// version it was made against and a reason, and lands in its history (§9.10).
class OfferFormScreen extends ConsumerStatefulWidget {
  const OfferFormScreen({super.key, this.edit});
  final OfferDetail? edit;

  @override
  ConsumerState<OfferFormScreen> createState() => _OfferFormScreenState();
}

class _OfferFormScreenState extends ConsumerState<OfferFormScreen> {
  late OfferTerms _terms;
  late final OfferTerms _before;
  late final Map<String, String> _vendorNames;
  late final Map<String, String> _itemNames;
  late final Map<String, String> _zoneNames;
  Map<String, String> _errors = const {};
  String? _refusal;
  bool _busy = false;
  String? _createId;
  OfferEdit? _pendingEdit;

  bool get _editing => widget.edit != null;

  @override
  void initState() {
    super.initState();
    final e = widget.edit;
    if (e != null) {
      _terms = e.terms;
      _vendorNames = {for (final v in e.vendors) v.id: v.name};
      _itemNames = {for (final i in e.items) i.id: i.name};
      _zoneNames = {for (final z in e.zones) z.id: z.name};
    } else {
      final zone = ref.read(activeZoneProvider);
      _terms = OfferTerms(code: '', kind: OfferKind.flat, value: 0, zoneIds: [?zone?.id]);
      _vendorNames = {};
      _itemNames = {};
      _zoneNames = {if (zone != null) zone.id: zone.name};
    }
    _before = _terms;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(_editing ? 'Edit ${widget.edit!.code}' : 'New offer'), backgroundColor: c.bg),
      body: ListView(
        key: const Key('offer-form'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 140),
        children: [
          OfferFields(
            value: _terms,
            errors: _errors,
            lockCode: _editing,
            lockFunding: _terms.requestId == null,
            vendorNames: _vendorNames,
            itemNames: _itemNames,
            zoneNames: _zoneNames,
            onNames: (v, i) => setState(() {
              _vendorNames.addAll(v);
              _itemNames.addAll(i);
            }),
            onChanged: (t) => setState(() {
              _terms = t;
              _createId = null;
              _pendingEdit = null;
              _refusal = null;
            }),
          ),
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
                  key: const Key('offer-refusal'),
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
                  child: Text(_refusal!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
                ),
              FilledButton(
                key: const Key('offer-save'),
                onPressed: _busy ? null : _save,
                child: Text(_busy ? 'Saving…' : (_editing ? 'Save changes' : 'Create offer')),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _save() async {
    final problems = offerProblems(_terms, creating: !_editing);
    setState(() => _errors = problems);
    if (problems.isNotEmpty) {
      showSnack(context, 'Fix the highlighted fields first.');
      return;
    }
    if (_editing) {
      if (_pendingEdit == null) {
        final changes = offerChanges(_before, _terms);
        if (changes.isEmpty) {
          showSnack(context, 'Nothing has changed.');
          return;
        }
        final reason = await showReasonDialog(
          context,
          title: 'Why change this offer?',
          message: 'The change and your reason are kept in its history.',
          quickPicks: const ['More demand than planned', 'Vendor asked', 'Fixing a mistake'],
          submitLabel: 'Save changes',
        );
        if (reason == null || !mounted) return;
        _pendingEdit = OfferEdit(changes: changes, expectedUpdatedAt: widget.edit!.updatedAt, reason: reason);
      }
      final edit = _pendingEdit!;
      await _run(() => ref.read(offersRepoProvider).update(widget.edit!.code, edit));
    } else {
      _createId ??= newActionId();
      await _run(() => ref.read(offersRepoProvider).create(_terms, clientActionId: _createId!));
    }
  }

  Future<void> _run(Future<Outcome<OfferDetail>> Function() call) async {
    setState(() => _busy = true);
    final Outcome<OfferDetail> out;
    try {
      out = await call();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
      showSnack(context, '${e.friendly} Tap Save to try again.');
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    switch (out) {
      case Applied(:final value):
        ref.invalidate(offerListProvider);
        if (_editing) {
          ref.invalidate(offerDetailProvider);
          showSnack(context, 'Offer updated.');
          Navigator.of(context).pop(true);
        } else {
          showSnack(context, 'Offer created.');
          final router = GoRouter.maybeOf(context);
          final code = value?.code ?? _terms.code;
          if (router != null) {
            router.pushReplacement('/more/offers/${Uri.encodeComponent(code)}');
          } else {
            Navigator.of(context).maybePop(true);
          }
        }
      case Refused(:final code, :final field):
        _createId = null;
        _pendingEdit = null;
        if (code == 'stale') ref.invalidate(offerDetailProvider);
        setState(() {
          _refusal = offerRefusal(code);
          _errors = {
            if (code == 'code_taken') 'code': 'Already used',
            ?field: 'Check this field',
          };
        });
    }
  }
}
