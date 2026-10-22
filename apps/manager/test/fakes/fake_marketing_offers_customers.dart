import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/data/customers_repository.dart';
import 'package:deligro_manager/data/marketing_repository.dart';
import 'package:deligro_manager/data/offers_repository.dart';
import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/finance.dart' show RefundPage;
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/offers.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/tickets.dart';

import '../fixtures/fixtures.dart';

Map<String, dynamic> p7(String name) => apiFixture('phase7/$name');

/// Pops the first queued outcome, or [fallback].
T _next<T>(List<T> q, T fallback) => q.isEmpty ? fallback : q.removeAt(0);

void _throwOnce(List<Object> q) {
  if (q.isNotEmpty) throw q.removeAt(0);
}

class FakeMarketingRepository implements MarketingRepository {
  MarketingRequestPage requestPage = MarketingRequestPage.fromJson(p7('marketing_requests'));
  RequestBundle requestBundle = RequestBundle.fromJson(p7('marketing_request_detail'));
  CampaignPage campaignPage = CampaignPage.fromJson(p7('campaigns_list'));
  CampaignBundle campaignBundle = CampaignBundle.fromJson(p7('campaign_detail'));

  final List<RequestFilters> requestQueries = [];
  final List<CampaignFilters> campaignQueries = [];
  final List<(String, RequestDecision)> decisions = [];
  final List<NewRequestInput> created = [];
  final List<(CampaignInput, String)> createdCampaigns = [];
  final List<(String, CampaignEdit)> edits = [];
  final List<(String, CampaignAction)> actions = [];

  final List<Outcome<RequestBundle>> decideOutcomes = [];
  final List<Outcome<CampaignDetail>> campaignOutcomes = [];
  final List<Object> decideFaults = [];
  Object? listError;

  @override
  Future<MarketingRequestPage> requests(RequestFilters f, {String? cursor}) async {
    requestQueries.add(f);
    if (listError != null) throw listError!;
    return requestPage;
  }

  @override
  Future<RequestBundle> request(String id) async => requestBundle;

  @override
  Future<Outcome<MarketingRequest>> createRequest(NewRequestInput input) async {
    created.add(input);
    return Applied(requestBundle.request);
  }

  @override
  Future<Outcome<RequestBundle>> decide(String id, RequestDecision d) async {
    decisions.add((id, d));
    _throwOnce(decideFaults);
    return _next(decideOutcomes, Applied(requestBundle));
  }

  @override
  Future<Outcome<MarketingRequest>> progress(String id, RequestProgress p) async => Applied(requestBundle.request);

  @override
  Future<CampaignPage> campaigns(CampaignFilters f, {String? cursor}) async {
    campaignQueries.add(f);
    return campaignPage;
  }

  @override
  Future<CampaignBundle> campaign(String id, {String? from, String? to}) async => campaignBundle;

  @override
  Future<Outcome<CampaignDetail>> createCampaign(CampaignInput input, {required String clientActionId}) async {
    createdCampaigns.add((input, clientActionId));
    return _next(campaignOutcomes, Applied(campaignBundle.campaign));
  }

  @override
  Future<Outcome<CampaignDetail>> updateCampaign(String id, CampaignEdit edit) async {
    edits.add((id, edit));
    return _next(campaignOutcomes, Applied(campaignBundle.campaign));
  }

  @override
  Future<Outcome<CampaignDetail>> actOnCampaign(String id, CampaignAction a) async {
    actions.add((id, a));
    return _next(campaignOutcomes, Applied(campaignBundle.campaign));
  }

  @override
  Future<Outcome<String>> uploadImage(String campaignId, XFile file) async => const Applied('https://example.test/new.jpg');
}

class FakeOffersRepository implements OffersRepository {
  OfferPage page = OfferPage.fromJson(p7('offers_list'));
  OfferBundle bundle = OfferBundle.fromJson(p7('offer_detail'));

  final List<OfferFilters> queries = [];
  final List<(OfferTerms, String)> created = [];
  final List<(String, OfferEdit)> edits = [];
  final List<(String, OfferAction)> actions = [];
  final List<Outcome<OfferDetail>> outcomes = [];

  @override
  Future<OfferPage> list(OfferFilters f, {String? cursor}) async {
    queries.add(f);
    return page;
  }

  @override
  Future<OfferBundle> detail(String code, {String? from, String? to}) async => bundle;

  @override
  Future<Outcome<OfferDetail>> create(OfferTerms terms, {required String clientActionId}) async {
    created.add((terms, clientActionId));
    return _next(outcomes, Applied(bundle.offer));
  }

  @override
  Future<Outcome<OfferDetail>> update(String code, OfferEdit edit) async {
    edits.add((code, edit));
    return _next(outcomes, Applied(bundle.offer));
  }

  @override
  Future<Outcome<OfferDetail>> act(String code, OfferAction a) async {
    actions.add((code, a));
    return _next(outcomes, Applied(bundle.offer));
  }
}

class FakeCustomersRepository implements CustomersRepository {
  CustomerPage page = CustomerPage.fromJson(p7('customers_list'));
  CustomerDetail detailValue = CustomerDetail.fromJson(p7('customer_detail')['customer'] as Map<String, dynamic>);
  TicketPage complaintPage = TicketPage.fromJson(p7('customer_complaints'));
  RefundPage refundPage = RefundPage.fromJson(p7('customer_refunds'));
  CustomerFeedback feedbackValue = CustomerFeedback.fromJson(p7('customer_feedback'));
  Retention retentionValue = Retention.fromJson(p7('retention'));

  final List<CustomerFilters> queries = [];
  final List<(String, ContactReason, String?)> reveals = [];
  final List<(String, CustomerAction)> actions = [];
  final List<Outcome<CustomerDetail>> actOutcomes = [];
  final List<Object> actFaults = [];
  ContactReveal contact = const ContactReveal(phone: '+919876543210');

  @override
  Future<CustomerPage> list(CustomerFilters f, {String? cursor}) async {
    queries.add(f);
    return page;
  }

  @override
  Future<CustomerDetail> detail(String id) async => detailValue;

  @override
  Future<TicketPage> complaints(String id, {String? cursor}) async => complaintPage;

  @override
  Future<RefundPage> refunds(String id, {String? cursor}) async => refundPage;

  @override
  Future<CustomerFeedback> feedback(String id, {String? cursor}) async => feedbackValue;

  @override
  Future<Outcome<ContactReveal>> revealContact(String id, ContactReason reason, {String? note, required String clientActionId}) async {
    reveals.add((id, reason, note));
    return Applied(contact);
  }

  @override
  Future<Outcome<CustomerDetail>> act(String id, CustomerAction a) async {
    actions.add((id, a));
    _throwOnce(actFaults);
    return _next(actOutcomes, Applied(detailValue));
  }

  @override
  Future<Retention> retention({String? from, String? to, String? zoneId}) async => retentionValue;
}
