import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../data/cash_repository.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_cash.dart';
import '../models/cash.dart';
import 'jobs.dart';
import 'providers.dart';

/// The cash routes, or in a debug build started with FIXTURES=true the
/// in-memory fixture backend. `fixturesEnabled` is a compile-time false in a
/// release build, so the fixture branch (and its data) is not in the app.
final cashRepoProvider = Provider<CashRepository>((ref) {
  if (fixturesEnabled) return FixtureCashRepository.create();
  return ApiCashRepository(ref.watch(apiProvider));
});

/// The Cash screen's figures; also the More badge and the Home strip. Not
/// auto-disposed (a pending-disposal timer would outlive a test's widget
/// tree), so it asks again by itself when it could have changed:
///
/// - a different rider signs in (it must never show another rider's cash);
/// - the delivery the rider carries moves (accepted, picked up, ended: cash is
///   collected when a delivery is completed);
/// - a `deliver` step is answered by the server, including one saved offline
///   and sent later;
/// - the app comes back to the front (rider_shell), after a deposit, a
///   withdrawal or a dispute, and when the Cash screen opens.
final cashSummaryProvider = FutureProvider<CashSummary>(retry: (_, _) => null, (
  ref,
) {
  ref.watch(userIdProvider);
  ref.watch(
    boardProvider.select((s) {
      final a = s.board?.active;
      return a == null ? null : '${a.orderId}:${a.status.name}';
    }),
  );
  final delivered = ref.read(actionQueueProvider).outcomes.listen((o) {
    if (o.done && o.action == 'deliver') ref.invalidateSelf();
  });
  ref.onDispose(delivered.cancel);
  return ref.watch(cashRepoProvider).summary();
});

final cashDepositsProvider = FutureProvider.autoDispose<List<CashDeposit>>(
  retry: (_, _) => null,
  (ref) {
    ref.watch(userIdProvider);
    return ref.watch(cashRepoProvider).deposits();
  },
);

final cashDisputesProvider = FutureProvider.autoDispose<List<CashDispute>>(
  retry: (_, _) => null,
  (ref) {
    ref.watch(userIdProvider);
    return ref.watch(cashRepoProvider).disputes();
  },
);

final cashManagersProvider = FutureProvider.autoDispose<List<CashManager>>(
  retry: (_, _) => null,
  (ref) => ref.watch(cashRepoProvider).managers(),
);

/// Asks every cash figure again (after a deposit, a withdrawal, a dispute).
void refreshCash(WidgetRef ref) {
  ref
    ..invalidate(cashSummaryProvider)
    ..invalidate(cashDepositsProvider)
    ..invalidate(cashDisputesProvider);
}

/// Where a receipt photo comes from: the camera or the gallery. Null when the
/// rider backed out. Tests replace it; there is no camera in a widget test.
typedef ReceiptPicker = Future<File?> Function({required bool camera});

Future<File?> _pickReceipt({required bool camera}) async {
  final shot = await ImagePicker().pickImage(
    source: camera ? ImageSource.camera : ImageSource.gallery,
    imageQuality: 80,
    maxWidth: 2400,
    maxHeight: 2400,
  );
  return shot == null ? null : File(shot.path);
}

final receiptPickerProvider = Provider<ReceiptPicker>((_) => _pickReceipt);
