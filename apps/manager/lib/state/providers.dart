import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../data/alerts_repository.dart';
import '../data/weather_repository.dart';
import '../data/audit_repository.dart';
import '../data/auth_repository.dart';
import '../data/inbox_repository.dart';
import '../data/cash_repository.dart';
import '../data/exceptions_repository.dart';
import '../data/finance_repository.dart';
import '../data/manager_repository.dart';
import '../data/orders_repository.dart';
import '../data/payments_repository.dart';
import '../data/products_repository.dart';
import '../data/reports_repository.dart';
import '../data/riders_repository.dart';
import '../data/tickets_repository.dart';
import '../data/vendors_repository.dart';

final supabaseProvider = Provider<SupabaseClient>((_) => Supabase.instance.client);

final apiProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(supabaseProvider).auth));

final authStateProvider = StreamProvider<AuthState>(
  (ref) => ref.watch(supabaseProvider).auth.onAuthStateChange,
);

/// Whether a session exists. Its own provider so the router (and tests) can
/// depend on it without a live Supabase client.
final signedInProvider = Provider<bool>((ref) {
  ref.watch(authStateProvider);
  return ref.watch(supabaseProvider).auth.currentSession != null;
});

final authRepoProvider = Provider(
  (ref) => AuthRepository(ref.watch(supabaseProvider).auth, ref.watch(apiProvider)),
);

final managerRepoProvider = Provider((ref) => ManagerRepository(ref.watch(apiProvider)));

/// Orders (§3) and the live board (§6). Overridden with fakes in tests.
final ordersRepoProvider = Provider<OrdersRepository>((ref) => ApiOrdersRepository(ref.watch(apiProvider)));

final liveRepoProvider = Provider<LiveRepository>((ref) => ApiLiveRepository(ref.watch(apiProvider)));

/// Vendors (§4), products (§12) and ticket threads. Overridden with fakes in tests.
final vendorsRepoProvider = Provider<VendorsRepository>((ref) => ApiVendorsRepository(ref.watch(apiProvider)));

final productsRepoProvider = Provider<ProductsRepository>((ref) => ApiProductsRepository(ref.watch(apiProvider)));

final ticketsRepoProvider = Provider<TicketsRepository>((ref) => ApiTicketsRepository(ref.watch(apiProvider)));

/// Riders (§5), maker–checker payments, rider cash and delivery exceptions.
/// Overridden with fakes in tests.
final ridersRepoProvider = Provider<RidersRepository>((ref) => ApiRidersRepository(ref.watch(apiProvider)));

final paymentsRepoProvider = Provider<PaymentsRepository>((ref) => ApiPaymentsRepository(ref.watch(apiProvider)));

final cashRepoProvider = Provider<CashRepository>((ref) => ApiCashRepository(ref.watch(apiProvider)));

final exceptionsRepoProvider = Provider<ExceptionsRepository>((ref) => ApiExceptionsRepository(ref.watch(apiProvider)));

/// Finance (§7) and reports (§13). Overridden with fakes in tests.
final financeRepoProvider = Provider<FinanceRepository>((ref) => ApiFinanceRepository(ref.watch(apiProvider)));

final reportsRepoProvider = Provider<ReportsRepository>((ref) => ApiReportsRepository(ref.watch(apiProvider)));

/// Alerts and thresholds (§14), the inbox, and the audit log (§16).
/// Overridden with fakes in tests.
final alertsRepoProvider = Provider<AlertsRepository>((ref) => ApiAlertsRepository(ref.watch(apiProvider)));

final inboxRepoProvider = Provider<InboxRepository>((ref) => ApiInboxRepository(ref.watch(apiProvider)));

final auditRepoProvider = Provider<AuditRepository>((ref) => ApiAuditRepository(ref.watch(apiProvider)));

final weatherRepoProvider = Provider<WeatherRepository>((ref) => ApiWeatherRepository(ref.watch(apiProvider)));

/// The weather of the zones this manager works in (0178).
final zoneWeatherProvider = FutureProvider.autoDispose<List<ZoneWeatherRow>>((ref) {
  ref.watch(signedInProvider);
  return ref.read(weatherRepoProvider).list();
});
