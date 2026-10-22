import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/report.dart';
import 'providers.dart';

/// The kinds this manager may run (the server decides).
final reportKindsProvider = FutureProvider.autoDispose<ReportKindList>((ref) {
  ref.watch(signedInProvider);
  return ref.read(reportsRepoProvider).kinds();
}, retry: (_, _) => null);

/// One page of one report.
final reportPageProvider = FutureProvider.autoDispose.family<ReportPayload, ReportQuery>((ref, q) {
  ref.watch(signedInProvider);
  return ref.read(reportsRepoProvider).run(q);
}, retry: (_, _) => null);
