import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../theme/app_theme.dart';

/// Prep times a kitchen picks most; anything else via "Other".
const prepChoices = [10, 15, 20, 30, 45, 60];

/// The reasons the website's kitchen board offers (reject-order-dialog.tsx).
/// The English text goes on the order verbatim and the customer reads it; the
/// Hindi is only the kitchen's label.
const rejectReasons = [
  ("We're too busy to take this order right now", 'अभी बहुत व्यस्त हैं, यह ऑर्डर नहीं ले सकते'),
  ('One of the items is out of stock', 'एक आइटम स्टॉक में नहीं है'),
  ('The kitchen is closed or closing shortly', 'किचन बंद है या जल्द बंद हो रहा है'),
  ("We can't deliver to that address", 'उस पते पर डिलीवरी नहीं कर सकते'),
];

/// Accept: how long until it's ready. Returns the minutes, or null if dismissed.
Future<int?> showAcceptSheet(BuildContext context, {required int defaultMinutes}) =>
    showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AcceptSheet(defaultMinutes: defaultMinutes),
    );

class _AcceptSheet extends ConsumerStatefulWidget {
  const _AcceptSheet({required this.defaultMinutes});
  final int defaultMinutes;

  @override
  ConsumerState<_AcceptSheet> createState() => _AcceptSheetState();
}

class _AcceptSheetState extends ConsumerState<_AcceptSheet> {
  late int _minutes = widget.defaultMinutes.clamp(1, 180);
  bool _other = false;
  final _custom = TextEditingController();

  @override
  void initState() {
    super.initState();
    _other = !prepChoices.contains(_minutes);
    if (_other) _custom.text = '$_minutes';
  }

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  int? get _value {
    if (!_other) return _minutes;
    final n = int.tryParse(_custom.text);
    return n != null && n >= 1 && n <= 180 ? n : null;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(tr(ref, 'Accept order', 'ऑर्डर स्वीकार करें'), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(tr(ref, 'How long until it\'s ready for pickup?', 'पिकअप के लिए तैयार होने में कितना समय लगेगा?'),
              style: TextStyle(color: c.muted)),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final m in prepChoices)
                ChoiceChip(
                  label: Text(tr(ref, '$m min', '$m मिनट')),
                  selected: !_other && _minutes == m,
                  showCheckmark: false,
                  onSelected: (_) => setState(() {
                    _other = false;
                    _minutes = m;
                  }),
                ),
              ChoiceChip(
                label: Text(tr(ref, 'Other', 'अन्य')),
                selected: _other,
                showCheckmark: false,
                onSelected: (_) => setState(() => _other = true),
              ),
            ],
          ),
          if (_other) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _custom,
              autofocus: true,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(3)],
              decoration: InputDecoration(
                labelText: tr(ref, 'Minutes (1–180)', 'मिनट (1–180)'),
                suffixText: tr(ref, 'min', 'मिनट'),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _value == null ? null : () => Navigator.pop(context, _value),
            icon: const Icon(Icons.check_rounded),
            label: Text(_value == null
                ? tr(ref, 'Accept', 'स्वीकार करें')
                : tr(ref, 'Accept · ready in $_value min', 'स्वीकार करें · $_value मिनट में तैयार')),
          ),
        ],
      ),
    );
  }
}

/// Reject: why. Returns the reason ('' = none given), or null if dismissed.
Future<String?> showRejectSheet(BuildContext context) => showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _RejectSheet(),
    );

class _RejectSheet extends ConsumerStatefulWidget {
  const _RejectSheet();

  @override
  ConsumerState<_RejectSheet> createState() => _RejectSheetState();
}

class _RejectSheetState extends ConsumerState<_RejectSheet> {
  int? _picked;
  final _other = TextEditingController();

  @override
  void dispose() {
    _other.dispose();
    super.dispose();
  }

  String get _reason => _picked == null
      ? _other.text.trim()
      : _picked! < rejectReasons.length
          ? rejectReasons[_picked!].$1
          : _other.text.trim();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final otherIndex = rejectReasons.length;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(tr(ref, 'Reject order', 'ऑर्डर मना करें'), style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              tr(ref, 'The customer sees this reason. If they paid online, Deligro refunds them.',
                  'ग्राहक को यह कारण दिखेगा। अगर ऑनलाइन भुगतान हुआ है, तो Deligro रिफंड करेगा।'),
              style: TextStyle(color: c.muted),
            ),
            const SizedBox(height: 12),
            RadioGroup<int>(
              groupValue: _picked,
              onChanged: (v) => setState(() => _picked = v),
              child: Column(
                children: [
                  for (var i = 0; i < rejectReasons.length; i++)
                    RadioListTile<int>(
                      value: i,
                      contentPadding: EdgeInsets.zero,
                      title: Text(tr(ref, rejectReasons[i].$1, rejectReasons[i].$2)),
                    ),
                  RadioListTile<int>(
                    value: otherIndex,
                    contentPadding: EdgeInsets.zero,
                    title: Text(tr(ref, 'Something else', 'कोई और कारण')),
                  ),
                ],
              ),
            ),
            if (_picked == otherIndex)
              TextField(
                controller: _other,
                autofocus: true,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(labelText: tr(ref, 'Reason for the customer', 'ग्राहक के लिए कारण')),
                onChanged: (_) => setState(() {}),
              ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: c.deal, foregroundColor: Colors.white),
              onPressed: () => Navigator.pop(context, _reason),
              child: Text(tr(ref, 'Reject order', 'ऑर्डर मना करें')),
            ),
          ],
        ),
      ),
    );
  }
}
