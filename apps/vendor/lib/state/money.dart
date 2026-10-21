import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/money_repository.dart';
import '../models/money.dart';
import 'providers.dart';

final moneyRepoProvider = Provider((ref) => MoneyRepository(ref.watch(apiProvider)));

/// The Payments tab; reloaded when the vendor switches shop.
final paymentsProvider = FutureProvider.autoDispose<Payments>((ref) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(moneyRepoProvider).payments();
});

final statementProvider = FutureProvider.autoDispose.family<Statement, String>(
  (ref, id) => ref.watch(moneyRepoProvider).statement(id),
);

final reportProvider = FutureProvider.autoDispose.family<SalesReport, ReportQuery>((ref, q) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(moneyRepoProvider).report(q);
});

/// The shop's details for invoices and receipts; kept for the session.
final invoiceProfileProvider = FutureProvider<InvoiceProfile>((ref) {
  ref.watch(activeShopSlugProvider);
  return ref.watch(moneyRepoProvider).invoiceProfile();
});
