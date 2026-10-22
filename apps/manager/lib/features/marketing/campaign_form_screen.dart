import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/marketing.dart';
import '../../models/offers.dart' show newActionId;
import '../../models/outcome.dart';
import '../../state/marketing.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/document_picker.dart';
import '../../widgets/zone_picker.dart';
import '../orders/reason_dialog.dart';
import 'campaign_fields.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';

/// Create a campaign (§8.4–8.9), or edit one: before it starts anything but
/// its type may change; once started only the end, budget, notes and banner,
/// and a reason is asked (§6.10 house rule for changes to running things).
class CampaignFormScreen extends ConsumerStatefulWidget {
  const CampaignFormScreen({super.key, this.initial, this.edit});

  /// A new campaign's starting values (else a blank Deligro-funded banner).
  final CampaignInput? initial;

  /// The campaign being edited.
  final CampaignDetail? edit;

  @override
  ConsumerState<CampaignFormScreen> createState() => _CampaignFormScreenState();
}

class _CampaignFormScreenState extends ConsumerState<CampaignFormScreen> {
  late CampaignInput _input;
  late final CampaignInput _before;
  late final Map<String, String> _vendorNames;
  late final Map<String, String> _itemNames;
  Map<String, String> _errors = const {};
  String? _refusal;
  bool _busy = false;
  bool _uploading = false;

  /// Minted on first send; kept while the input is unchanged so a retry is the
  /// same write.
  String? _createId;
  CampaignEdit? _pendingEdit;

  bool get _editing => widget.edit != null;
  bool get _windowOnly => widget.edit?.allowed.editWindowOnly ?? false;

  @override
  void initState() {
    super.initState();
    final e = widget.edit;
    if (e != null) {
      _input = e.input;
      _vendorNames = {for (final v in e.vendors) v.id: v.name};
      _itemNames = {for (final i in e.items) i.id: i.name};
    } else {
      final zone = ref.read(activeZoneProvider);
      final zones = myZones(ref);
      _input = widget.initial ??
          CampaignInput(
            kind: CampaignKind.banner,
            title: '',
            zoneId: zone?.id ?? (zones.isEmpty ? '' : zones.first.id),
            fundedBy: Funding.deligro,
            banner: const BannerFields(),
          );
      _vendorNames = {};
      _itemNames = {};
    }
    _before = _input;
  }

  /// End before start: shown at once and Save stays off (it can never pass).
  String? get _orderProblem {
    final s = _input.startsAt, e = _input.endsAt;
    return s != null && e != null && !e.isAfter(s) ? 'The end must be after the start' : null;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final e = widget.edit;
    final errors = {..._errors, 'endsAt': ?_orderProblem ?? _errors['endsAt']};
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(_editing ? 'Edit campaign' : 'New campaign'), backgroundColor: c.bg),
      body: ListView(
        key: const Key('campaign-form'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 140),
        children: [
          if (_windowOnly)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
              child: Text(
                'This campaign has started: only the end, budget, notes and banner can change, and you will be asked why.',
                style: TextStyle(color: c.ink, fontSize: 13.5),
              ),
            ),
          CampaignFields(
            value: _input,
            errors: errors,
            lockKind: _editing,
            lockVendor: _windowOnly,
            windowOnly: _windowOnly,
            lockFunding: _input.requestId == null,
            vendorNames: _vendorNames,
            itemNames: _itemNames,
            onNames: (v, i) => setState(() {
              _vendorNames.addAll(v);
              _itemNames.addAll(i);
            }),
            onChanged: (v) => setState(() {
              _input = v;
              _createId = null;
              _pendingEdit = null;
              _refusal = null;
            }),
          ),
          if (_input.kind.hasBanner)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: e == null
                  ? Text('Add the banner image after saving the campaign.', style: TextStyle(color: c.muted, fontSize: 13))
                  : e.allowed.uploadImage
                      ? OutlinedButton.icon(
                          key: const Key('campaign-image'),
                          onPressed: _uploading ? null : _upload,
                          icon: const Icon(Icons.image_outlined),
                          label: Text(_uploading ? 'Uploading…' : 'Choose banner image (JPEG or PNG, up to 2 MB)'),
                        )
                      : const SizedBox.shrink(),
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
                  key: const Key('campaign-refusal'),
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
                  child: Text(_refusal!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
                ),
              FilledButton(
                key: const Key('campaign-save'),
                onPressed: _busy || _orderProblem != null ? null : _save,
                child: Text(_busy ? 'Saving…' : (_editing ? 'Save changes' : 'Create campaign')),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _upload() async {
    final f = await ref.read(documentPickerProvider)(context);
    if (f == null || !mounted) return;
    final name = f.name.toLowerCase();
    if (!(name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png'))) {
      showSnack(context, 'Pick a JPEG or PNG image.');
      return;
    }
    if (await f.length() > 2 * 1024 * 1024) {
      if (mounted) showSnack(context, 'That image is over 2 MB. Pick a smaller one.');
      return;
    }
    setState(() => _uploading = true);
    try {
      final out = await ref.read(marketingRepoProvider).uploadImage(widget.edit!.id, f);
      if (!mounted) return;
      switch (out) {
        case Applied(:final value?):
          setState(() {
            _input = _input.copyWith(banner: (_input.banner ?? const BannerFields()).copyWith(imageUrl: value));
            _pendingEdit = null;
          });
          showSnack(context, 'Image uploaded. Save to put it on the banner.');
        case Applied():
          showSnack(context, "The image didn't upload. Try again.");
        case Refused(:final code):
          showSnack(context, code == 'bad_file' ? "That image can't be used." : "The image didn't upload ($code).");
      }
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _save() async {
    final problems = _input.problems();
    if (_windowOnly) {
      // Only the editable fields can be wrong now.
      problems.removeWhere((k, _) => !{'endsAt', 'budget', 'headline', 'ctaLabel', 'description'}.contains(k));
    }
    setState(() => _errors = problems);
    if (problems.isNotEmpty) {
      showSnack(context, 'Fix the highlighted fields first.');
      return;
    }
    if (_editing) {
      await _saveEdit();
    } else {
      _createId ??= newActionId();
      await _run(() => ref.read(marketingRepoProvider).createCampaign(_input, clientActionId: _createId!));
    }
  }

  Future<void> _saveEdit() async {
    if (_pendingEdit == null) {
      final changes = campaignChanges(_before, _input, windowOnly: _windowOnly);
      if (changes.isEmpty) {
        showSnack(context, 'Nothing has changed.');
        return;
      }
      String? reason;
      if (_windowOnly) {
        reason = await showReasonDialog(
          context,
          title: 'Why change a running campaign?',
          quickPicks: const ['Vendor asked by phone', 'Budget changed', 'Extended for demand'],
          submitLabel: 'Save changes',
        );
        if (reason == null || !mounted) return;
      }
      _pendingEdit = CampaignEdit(changes: changes, expectedUpdatedAt: widget.edit!.updatedAt, reason: reason);
    }
    final edit = _pendingEdit!;
    await _run(() => ref.read(marketingRepoProvider).updateCampaign(widget.edit!.id, edit));
  }

  Future<void> _run(Future<Outcome<CampaignDetail>> Function() call) async {
    setState(() => _busy = true);
    final Outcome<CampaignDetail> out;
    try {
      out = await call();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('${e.friendly} Tap Save to try again.')));
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    switch (out) {
      case Applied(:final value):
        ref.invalidate(campaignListProvider);
        if (_editing) {
          ref.invalidate(campaignDetailProvider);
          showSnack(context, 'Campaign updated.');
          Navigator.of(context).pop(true);
        } else {
          showSnack(context, 'Campaign scheduled.');
          final router = GoRouter.maybeOf(context);
          if (value != null && router != null) {
            router.pushReplacement('/more/marketing/campaigns/${value.id}');
          } else {
            Navigator.of(context).maybePop(true);
          }
        }
      case Refused(:final code, :final field, :final extra):
        _createId = null;
        _pendingEdit = null;
        if (code == 'stale') ref.invalidate(campaignDetailProvider);
        setState(() {
          _refusal = marketingRefusal(code, extra);
          _errors = {
            if (code == 'slot_taken') 'slotPosition': 'Slot ${extra['slot'] ?? ''} is taken in those dates',
            ?field: 'Check this field',
          };
        });
    }
  }
}
