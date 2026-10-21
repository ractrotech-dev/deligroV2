import '../core/api.dart';
import '../models/money.dart';

/// Payments, statements, the sales report and the shop's invoice details.
/// All reads; settlements are Deligro's to create and pay.
class MoneyRepository {
  MoneyRepository(this._api);

  final ApiClient _api;

  Future<Payments> payments() async => Payments.fromJson(await _api.get('/api/vendor/payments'));

  Future<Statement> statement(String id) async => Statement.fromJson(
    ((await _api.get('/api/vendor/payments/settlements/$id'))['statement'] as Map).cast<String, dynamic>(),
  );

  Future<SalesReport> report(ReportQuery q) async =>
      SalesReport.fromJson(await _api.get('/api/vendor/reports', query: q.toQuery()));

  Future<InvoiceProfile> invoiceProfile() async => InvoiceProfile.fromJson(
    ((await _api.get('/api/vendor/invoice-profile'))['profile'] as Map).cast<String, dynamic>(),
  );
}
