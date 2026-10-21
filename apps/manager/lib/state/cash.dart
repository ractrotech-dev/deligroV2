import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/cash.dart';
import 'providers.dart';

/// Rider deposits with one status (`submitted`, `confirmed`, `disputed`).
final depositsProvider = FutureProvider.autoDispose.family<CashDepositPage, String>(
  (ref, status) {
    ref.watch(signedInProvider);
    return ref.read(cashRepoProvider).deposits(status: status);
  },
  retry: (_, _) => null,
);

/// Cash disputes with one status (`open`, `resolved`).
final disputesProvider = FutureProvider.autoDispose.family<CashDisputePage, String>(
  (ref, status) {
    ref.watch(signedInProvider);
    return ref.read(cashRepoProvider).disputes(status: status);
  },
  retry: (_, _) => null,
);

/// Deposits waiting for a manager — the More menu's badge. Null when it
/// can't be read.
final pendingDepositsCountProvider = FutureProvider.autoDispose<int?>((ref) async {
  ref.watch(signedInProvider);
  try {
    return (await ref.read(cashRepoProvider).deposits(status: 'submitted')).counts.submitted;
  } catch (_) {
    return null;
  }
}, retry: (_, _) => null);
