import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../theme/app_theme.dart';

/// Prep times a kitchen picks most; anything else via "Other".
const prepChoices = [10, 15, 20, 30, 45, 60];

/// The reasons the website's kitchen board offers (reject-order-dialog.tsx).
/// The text goes on the order verbatim and the customer reads it.
const rejectReasons = [
  ("We're too busy to take this order right now"),
  ('One of the items is out of stock'),
  ('The kitchen is closed or closing shortly'),
  ("We can't deliver to that address"),
];

/// Accept: how long until it's ready. Returns the minutes, or null if dismissed.
Future<int?> showAcceptSheet(BuildContext context, {required int defaultMinutes}) => showModalBottomSheet<int>(
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
          Text('Accept order', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text('How long until it\'s ready for pickup?', style: TextStyle(color: c.muted)),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final m in prepChoices)
                ChoiceChip(
                  label: Text('$m min'),
                  selected: !_other && _minutes == m,
                  showCheckmark: false,
                  onSelected: (_) => setState(() {
                    _other = false;
                    _minutes = m;
                  }),
                ),
              ChoiceChip(
                label: Text('Other'),
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
              decoration: InputDecoration(labelText: 'Minutes (1–180)', suffixText: 'min'),
              onChanged: (_) => setState(() {}),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _value == null ? null : () => Navigator.pop(context, _value),
            icon: const Icon(Icons.check_rounded),
            label: Text(_value == null ? 'Accept' : 'Accept · ready in $_value min'),
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
      ? rejectReasons[_picked!]
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
            Text('Reject order', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              'The customer sees this reason. If they paid online, Deligro refunds them.',
              style: TextStyle(color: c.muted),
            ),
            const SizedBox(height: 12),
            RadioGroup<int>(
              groupValue: _picked,
              onChanged: (v) => setState(() => _picked = v),
              child: Column(
                children: [
                  for (var i = 0; i < rejectReasons.length; i++)
                    RadioListTile<int>(value: i, contentPadding: EdgeInsets.zero, title: Text(rejectReasons[i])),
                  RadioListTile<int>(value: otherIndex, contentPadding: EdgeInsets.zero, title: Text('Something else')),
                ],
              ),
            ),
            if (_picked == otherIndex)
              TextField(
                controller: _other,
                autofocus: true,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(labelText: 'Reason for the customer'),
                onChanged: (_) => setState(() {}),
              ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: c.deal, foregroundColor: Colors.white),
              onPressed: () => Navigator.pop(context, _reason),
              child: Text('Reject order'),
            ),
          ],
        ),
      ),
    );
  }
}
