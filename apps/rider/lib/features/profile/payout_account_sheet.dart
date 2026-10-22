import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/profile_repository.dart';
import '../../models/profile.dart';
import 'edit_sheets.dart';
import 'form_sheet.dart';

final _ifsc = RegExp(r'^[A-Z]{4}0[A-Z0-9]{6}$');
final _upi = RegExp(r'^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$');
final _digits9to18 = RegExp(r'^\d{9,18}$');

String _noSpaces(String s) => s.replaceAll(RegExp(r'\s+'), '');

/// Asks for a new bank account or UPI id. The account on file is shown
/// masked only, the number being typed is hidden (with a Show toggle) and has
/// to be typed twice, and the request always waits for Deligro: payouts keep
/// going to the approved account until it is decided. Returns the sentence to
/// show once it was sent, or null.
Future<String?> showPayoutAccountSheet(BuildContext context, ProfileRepository repo, RiderProfile p) async {
  final current = p.payoutAccount;
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: current == null ? 'Add your payout account' : 'Change your payout account',
      intro: 'Deligro checks every new account before paying into it. Until then, payments go to the account on file.',
      header: current == null ? null : CurrentValueNote('On file: ${current.kindLabel} ${current.masked}'),
      submitLabel: 'Send for approval',
      fields: [
        const FieldSpec(
          'kind',
          'Pay me by',
          kind: FieldKind.choice,
          initial: 'bank',
          options: [('bank', 'Bank account'), ('upi', 'UPI')],
        ),
        FieldSpec(
          'holderName',
          'Name on the account',
          capitalization: TextCapitalization.words,
          maxLength: 100,
          visibleWhen: (v) => v['kind'] == 'bank',
        ),
        FieldSpec(
          'accountNumber',
          'Account number',
          keyboard: TextInputType.number,
          sensitive: true,
          maxLength: 18,
          formatters: [FilteringTextInputFormatter.digitsOnly],
          visibleWhen: (v) => v['kind'] == 'bank',
        ),
        FieldSpec(
          'confirmAccountNumber',
          'Type the account number again',
          keyboard: TextInputType.number,
          sensitive: true,
          maxLength: 18,
          formatters: [FilteringTextInputFormatter.digitsOnly],
          visibleWhen: (v) => v['kind'] == 'bank',
        ),
        FieldSpec(
          'ifsc',
          'IFSC code',
          capitalization: TextCapitalization.characters,
          maxLength: 11,
          helper: 'Like HDFC0001234',
          visibleWhen: (v) => v['kind'] == 'bank',
        ),
        FieldSpec(
          'upiId',
          'UPI ID',
          keyboard: TextInputType.emailAddress,
          maxLength: 80,
          helper: 'Like name@okbank',
          visibleWhen: (v) => v['kind'] == 'upi',
        ),
        FieldSpec(
          'upiHolder',
          'Name on the UPI account',
          capitalization: TextCapitalization.words,
          maxLength: 100,
          optional: true,
          visibleWhen: (v) => v['kind'] == 'upi',
        ),
      ],
      validate: (v) {
        if (v['kind'] == 'upi') {
          final holder = v['upiHolder']!.trim();
          return {
            if (!_upi.hasMatch(v['upiId']!.trim().toLowerCase())) 'upiId': 'Enter a UPI ID like name@okbank.',
            if (holder.isNotEmpty && nameProblem(holder, max: 100) != null) 'upiHolder': nameProblem(holder, max: 100)!,
          };
        }
        final account = _noSpaces(v['accountNumber']!);
        return {
          if (nameProblem(v['holderName']!, max: 100) != null) 'holderName': nameProblem(v['holderName']!, max: 100)!,
          if (!_digits9to18.hasMatch(account)) 'accountNumber': 'An account number has 9 to 18 digits.',
          if (_digits9to18.hasMatch(account) && _noSpaces(v['confirmAccountNumber']!) != account)
            'confirmAccountNumber': 'The two numbers do not match.',
          if (!_ifsc.hasMatch(_noSpaces(v['ifsc']!).toUpperCase())) 'ifsc': 'Enter an IFSC like HDFC0001234.',
        };
      },
      serverFields: const {
        'holderName': 'holderName',
        'accountNumber': 'accountNumber',
        'confirmAccountNumber': 'confirmAccountNumber',
        'ifsc': 'ifsc',
        'upiId': 'upiId',
      },
      onSubmit: (v) async {
        if (v['kind'] == 'upi') {
          final holder = v['upiHolder']!.trim();
          await repo.requestChange('payout_account', {
            'kind': 'upi',
            'upiId': v['upiId']!.trim().toLowerCase(),
            if (holder.isNotEmpty) 'holderName': holder,
          });
        } else {
          await repo.requestChange('payout_account', {
            'kind': 'bank',
            'holderName': v['holderName']!.trim(),
            'accountNumber': _noSpaces(v['accountNumber']!),
            'confirmAccountNumber': _noSpaces(v['confirmAccountNumber']!),
            'ifsc': _noSpaces(v['ifsc']!).toUpperCase(),
          });
        }
      },
    ),
  );
  return saved ? 'Payout account change sent. Waiting for Deligro.' : null;
}
