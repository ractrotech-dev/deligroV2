import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/data/cash_repository.dart';
import 'package:deligro_manager/data/exceptions_repository.dart';
import 'package:deligro_manager/data/payments_repository.dart';
import 'package:deligro_manager/data/riders_repository.dart';
import 'package:deligro_manager/models/cash.dart';
import 'package:deligro_manager/models/delivery_exception.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/rider.dart';

import '../fixtures/fixtures.dart';

Map<String, dynamic> p5(String name) => apiFixture('phase5/$name');

Map<String, dynamic> riderDetailJson({bool money = true}) =>
    Map<String, dynamic>.from(
      p5(money ? 'rider_detail' : 'rider_detail_no_money')['rider'] as Map,
    );

RiderDetail fixtureRider({
  bool money = true,
  Map<String, dynamic> patch = const {},
}) => RiderDetail.fromJson({...riderDetailJson(money: money), ...patch});

T? _pop<T>(List<T> q) => q.isEmpty ? null : q.removeAt(0);

class FakeRidersRepository implements RidersRepository {
  FakeRidersRepository({RiderPage? page, RiderDetail? detail})
    : page = page ?? RiderPage.fromJson(p5('riders_list')),
      detailValue = detail ?? fixtureRider();

  RiderPage page;
  final Map<String?, RiderPage> pages = {};
  RiderDetail detailValue;
  RiderHistoryPage historyPage = RiderHistoryPage.fromJson(p5('rider_history'));
  LedgerPage ledgerPage = LedgerPage.fromJson(p5('rider_ledger'));

  Object? listError;
  Object? detailError;

  /// One-shot faults for act / onboard, then the queued outcomes.
  Object? actError;
  Object? onboardError;
  final List<Outcome<RiderDetail>> actOutcomes = [];
  final List<Outcome<RiderOnboardResult>> onboardOutcomes = [];

  /// Per upload call, in order: an [Outcome] or an error to throw.
  final List<Object> uploadResults = [];

  final listCalls = <({RiderFilters filters, String? cursor})>[];
  final detailCalls = <String>[];
  final historyCalls = <({RiderOutcome? outcome, String? cursor})>[];
  final ledgerCalls = <LedgerStatus?>[];
  final actCalls = <({String id, RiderAction action})>[];
  final onboardCalls = <({RiderOnboardDraft draft, String clientActionId})>[];
  final uploadCalls =
      <({String id, RiderDocType type, String clientActionId})>[];
  final urlCalls = <String>[];

  @override
  Future<RiderPage> list(RiderFilters f, {String? cursor}) async {
    listCalls.add((filters: f, cursor: cursor));
    if (listError != null) throw listError!;
    return pages[cursor] ??
        (cursor == null ? page : const RiderPage(items: []));
  }

  @override
  Future<RiderDetail> detail(String id) async {
    detailCalls.add(id);
    if (detailError != null) throw detailError!;
    return detailValue;
  }

  @override
  Future<RiderHistoryPage> history(
    String id, {
    DateTime? from,
    DateTime? to,
    RiderOutcome? outcome,
    String? cursor,
  }) async {
    historyCalls.add((outcome: outcome, cursor: cursor));
    return historyPage;
  }

  @override
  Future<RatingPage> ratings(String id, {String? cursor}) async =>
      RatingPage.fromJson(p5('rider_ratings'));

  @override
  Future<LedgerPage> ledger(
    String id, {
    DateTime? from,
    DateTime? to,
    LedgerStatus? status,
    String? cursor,
  }) async {
    ledgerCalls.add(status);
    return ledgerPage;
  }

  @override
  Future<String> documentUrl(String id, String docId) async {
    urlCalls.add(docId);
    return 'https://example.test/$docId.jpg';
  }

  @override
  Future<Outcome<RiderDetail>> act(String id, RiderAction a) async {
    actCalls.add((id: id, action: a));
    final e = actError;
    if (e != null) {
      actError = null;
      throw e;
    }
    return _pop(actOutcomes) ?? Applied(detailValue);
  }

  @override
  Future<Outcome<RiderOnboardResult>> onboard(
    RiderOnboardDraft d,
    String clientActionId,
  ) async {
    onboardCalls.add((draft: d, clientActionId: clientActionId));
    final e = onboardError;
    if (e != null) {
      onboardError = null;
      throw e;
    }
    return _pop(onboardOutcomes) ??
        Applied(RiderOnboardResult.fromJson(p5('rider_onboard')));
  }

  @override
  Future<Outcome<RiderDocument>> upload(
    String id, {
    required RiderDocType type,
    required XFile file,
    String? number,
    DateTime? expiresOn,
    required String clientActionId,
  }) async {
    uploadCalls.add((id: id, type: type, clientActionId: clientActionId));
    final r = _pop(uploadResults);
    if (r is Outcome<RiderDocument>) return r;
    if (r != null) throw r;
    return Applied(
      RiderDocument.fromJson({
        ...(p5('rider_document')['document'] as Map).cast<String, dynamic>(),
        'type': type.wire,
      }),
    );
  }
}

class FakePaymentsRepository implements PaymentsRepository {
  FakePaymentsRepository({PaymentRequestPage? page})
    : page = page ?? PaymentRequestPage.fromJson(p5('payment_requests'));

  PaymentRequestPage page;
  Object? listError;
  Object? decideError;
  final List<Outcome<PaymentRequest>> decideOutcomes = [];
  final List<Outcome<PaymentRequest>> requestOutcomes = [];

  final listCalls = <PaymentRequestFilters>[];
  final requestCalls = <PayoutRequestDraft>[];
  final decideCalls = <({String id, PaymentDecision decision})>[];

  @override
  Future<PaymentRequestPage> list(
    PaymentRequestFilters f, {
    String? cursor,
  }) async {
    listCalls.add(f);
    if (listError != null) throw listError!;
    return page;
  }

  @override
  Future<Outcome<PaymentRequest>> request(PayoutRequestDraft d) async {
    requestCalls.add(d);
    return _pop(requestOutcomes) ?? Applied(page.items.first);
  }

  @override
  Future<Outcome<PaymentRequest>> decide(String id, PaymentDecision d) async {
    decideCalls.add((id: id, decision: d));
    final e = decideError;
    if (e != null) {
      decideError = null;
      throw e;
    }
    return _pop(decideOutcomes) ??
        Applied(
          page.items.firstWhere(
            (r) => r.id == id,
            orElse: () => page.items.first,
          ),
        );
  }
}

class FakeCashRepository implements CashRepository {
  CashDepositPage depositPage = CashDepositPage.fromJson(p5('cash_deposits'));
  CashDisputePage disputePage = CashDisputePage.fromJson(p5('cash_disputes'));
  final List<Outcome<CashDeposit>> depositOutcomes = [];
  final List<Outcome<CashDispute>> disputeOutcomes = [];

  final depositCalls = <String?>[];
  final decideCalls = <({String id, DepositDecision decision})>[];
  final resolveCalls = <({String id, DisputeResolution resolution})>[];

  @override
  Future<CashDepositPage> deposits({
    String? status,
    String? riderId,
    String? cursor,
  }) async {
    depositCalls.add(status);
    if (status != null && status != 'submitted') {
      return CashDepositPage(items: const [], counts: depositPage.counts);
    }
    return depositPage;
  }

  @override
  Future<CashDisputePage> disputes({String? status, String? cursor}) async =>
      status == null
      ? disputePage
      : CashDisputePage(
          items: [
            for (final d in disputePage.items)
              if (d.status.name == status) d,
          ],
          counts: disputePage.counts,
        );

  @override
  Future<String> depositPhotoUrl(String id) async =>
      'https://example.test/receipt-$id.jpg';

  @override
  Future<Outcome<CashDeposit>> decideDeposit(
    String id,
    DepositDecision d,
  ) async {
    decideCalls.add((id: id, decision: d));
    return _pop(depositOutcomes) ??
        Applied(depositPage.items.firstWhere((x) => x.id == id));
  }

  @override
  Future<Outcome<CashDispute>> resolveDispute(
    String id,
    DisputeResolution r,
  ) async {
    resolveCalls.add((id: id, resolution: r));
    return _pop(disputeOutcomes) ??
        Applied(disputePage.items.firstWhere((x) => x.id == id));
  }
}

class FakeExceptionsRepository implements ExceptionsRepository {
  FakeExceptionsRepository({ExceptionPage? page})
    : page = page ?? ExceptionPage.fromJson(p5('exceptions'));

  ExceptionPage page;

  /// Per decide call, in order: an [Outcome] or an error to throw.
  final List<Object> decideResults = [];
  final listCalls = <String>[];
  final decideCalls = <({String id, ExceptionAction action})>[];

  @override
  Future<ExceptionPage> list({
    String status = 'pending',
    String? riderId,
    String? cursor,
  }) async {
    listCalls.add(status);
    return page;
  }

  @override
  Future<String> photoUrl(String id) async => 'https://example.test/ex-$id.jpg';

  @override
  Future<Outcome<DeliveryException>> decide(
    String id,
    ExceptionAction a,
  ) async {
    decideCalls.add((id: id, action: a));
    final r = _pop(decideResults);
    if (r is Outcome<DeliveryException>) return r;
    if (r != null) throw r;
    return Applied(page.items.firstWhere((x) => x.id == id));
  }
}
