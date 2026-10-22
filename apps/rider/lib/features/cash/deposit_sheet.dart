import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money.dart';
import '../../state/cash.dart';
import '../../theme/app_theme.dart';
import 'cash_errors.dart';

/// The longest note the server keeps.
const depositNoteMax = 300;

/// Declares a deposit: how much, cash or UPI, to which manager, with the
/// receipt. [available] is the cash that can still be declared (what the
/// rider holds less deposits already waiting); the amount starts at it.
/// True when the deposit was sent.
Future<bool?> showDepositSheet(BuildContext context, {required int available}) =>
    showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (_) => DepositSheet(available: available),
    );

class DepositSheet extends ConsumerStatefulWidget {
  const DepositSheet({super.key, required this.available});

  final int available;

  @override
  ConsumerState<DepositSheet> createState() => _DepositSheetState();
}

class _DepositSheetState extends ConsumerState<DepositSheet> {
  late final _amount = TextEditingController(text: '${widget.available}');
  final _reference = TextEditingController();
  final _note = TextEditingController();
  bool _upi = false;
  String? _managerId;
  File? _photo;
  bool _busy = false;
  String? _amountError;
  String? _referenceError;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pick(bool camera) async {
    final file = await ref.read(receiptPickerProvider)(camera: camera);
    if (file != null && mounted) setState(() => _photo = file);
  }

  Future<void> _send() async {
    if (_busy) return;
    final amount = int.tryParse(_amount.text.trim());
    final reference = _reference.text.trim();
    setState(() {
      _error = null;
      _amountError = amount == null || amount <= 0
          ? 'Enter a whole number of rupees above zero.'
          : amount > widget.available
          ? 'You can deposit at most ${money(widget.available)} right now.'
          : null;
      _referenceError = _upi && reference.isEmpty
          ? 'Enter the UPI reference for this payment.'
          : null;
    });
    if (_amountError != null || _referenceError != null) return;
    setState(() => _busy = true);
    try {
      await ref
          .read(cashRepoProvider)
          .submitDeposit(
            amount: amount!,
            upi: _upi,
            managerId: _managerId,
            reference: _upi ? reference : null,
            note: _note.text,
            photo: _photo,
          );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = cashErrorText(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final managers = ref.watch(cashManagersProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Deposit cash',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(
                'A manager confirms it before it comes off your pending cash.',
                style: TextStyle(color: c.muted),
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('deposit-amount'),
                controller: _amount,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(
                  labelText: 'Amount',
                  prefixText: '₹ ',
                  errorText: _amountError,
                  helperText: 'You can deposit up to ${money(widget.available)}',
                ),
              ),
              const SizedBox(height: 14),
              SegmentedButton<bool>(
                key: const Key('deposit-method'),
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(
                    value: false,
                    label: Text('Cash'),
                    icon: Icon(Icons.payments_outlined),
                  ),
                  ButtonSegment(
                    value: true,
                    label: Text('UPI'),
                    icon: Icon(Icons.qr_code_2_rounded),
                  ),
                ],
                selected: {_upi},
                onSelectionChanged: (s) => setState(() {
                  _upi = s.first;
                  _referenceError = null;
                }),
              ),
              if (_upi) ...[
                const SizedBox(height: 14),
                TextField(
                  key: const Key('deposit-reference'),
                  controller: _reference,
                  textCapitalization: TextCapitalization.characters,
                  maxLength: 64,
                  decoration: InputDecoration(
                    labelText: 'UPI reference',
                    counterText: '',
                    errorText: _referenceError,
                  ),
                ),
              ],
              const SizedBox(height: 14),
              managers.when(
                data: (list) => DropdownButtonFormField<String?>(
                  key: const Key('deposit-manager'),
                  initialValue: _managerId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Manager'),
                  items: [
                    const DropdownMenuItem<String?>(
                      value: null,
                      child: Text('Any manager'),
                    ),
                    for (final m in list)
                      DropdownMenuItem<String?>(
                        value: m.id,
                        child: Text(m.name, overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: (v) => setState(() => _managerId = v),
                ),
                loading: () => const LinearProgressIndicator(),
                // The manager is optional; a failed list is not a blocker.
                error: (_, _) => Text(
                  'The manager list could not be loaded. A manager can still confirm this.',
                  style: TextStyle(color: c.muted, fontSize: 13),
                ),
              ),
              const SizedBox(height: 14),
              _PhotoRow(
                photo: _photo,
                onCamera: () => _pick(true),
                onGallery: () => _pick(false),
                onRemove: () => setState(() => _photo = null),
              ),
              const SizedBox(height: 14),
              TextField(
                key: const Key('deposit-note'),
                controller: _note,
                maxLength: depositNoteMax,
                maxLines: 2,
                minLines: 1,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  labelText: 'Note (optional)',
                ),
              ),
              if (_error != null)
                Padding(
                  key: const Key('deposit-error'),
                  padding: const EdgeInsets.only(top: 4, bottom: 4),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: c.deal,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('deposit-cancel'),
                      onPressed: _busy ? null : () => Navigator.pop(context),
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      key: const Key('deposit-send'),
                      onPressed: _busy ? null : _send,
                      child: _busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2.5),
                            )
                          : const Text('Send to manager'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PhotoRow extends StatelessWidget {
  const _PhotoRow({
    required this.photo,
    required this.onCamera,
    required this.onGallery,
    required this.onRemove,
  });

  final File? photo;
  final VoidCallback onCamera;
  final VoidCallback onGallery;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final file = photo;
    if (file != null) {
      return Row(
        key: const Key('deposit-photo-attached'),
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.file(
              file,
              width: 56,
              height: 56,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => Container(
                width: 56,
                height: 56,
                color: c.surface2,
                child: Icon(Icons.image_outlined, color: c.muted),
              ),
            ),
          ),
          const SizedBox(width: 12),
          const Expanded(
            child: Text(
              'Receipt attached',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          TextButton(
            key: const Key('deposit-photo-remove'),
            onPressed: onRemove,
            child: const Text('Remove'),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Receipt photo (optional)',
          style: TextStyle(color: c.muted, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('deposit-photo-camera'),
                onPressed: onCamera,
                icon: const Icon(Icons.photo_camera_outlined),
                label: const Text('Take photo'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('deposit-photo-gallery'),
                onPressed: onGallery,
                icon: const Icon(Icons.photo_library_outlined),
                label: const Text('Choose'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
