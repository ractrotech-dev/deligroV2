import 'package:deligro_partner/core/push.dart';
import 'package:deligro_partner/data/growth_repository.dart';
import 'package:deligro_partner/features/marketing/marketing_screens.dart';
import 'package:deligro_partner/features/notifications/notifications_screen.dart';
import 'package:deligro_partner/features/offers/offer_editor_screen.dart';
import 'package:deligro_partner/features/offers/offers_screen.dart';
import 'package:deligro_partner/features/reviews/reviews_screen.dart';
import 'package:deligro_partner/models/growth.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/growth.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

class MockGrowthRepo extends Mock implements GrowthRepository {}

const _uuid = 'aa11aa11-0000-0000-0000-000000000001';

Map<String, dynamic> offersJson() => {
  'own': [
    {
      'code': 'SPICE20',
      'label': 'Diwali',
      'kind': 'percent',
      'value': 20,
      'minOrder': 199,
      'maxDiscount': 80,
      'active': true,
      'redemptions': 12,
      'maxRedemptions': 100,
      'status': 'live',
      'impact': {'orders': 12, 'sales': 5400, 'discount': 720},
    },
    {
      'code': 'SOON50',
      'kind': 'flat',
      'value': 50,
      'active': true,
      'status': 'scheduled',
      'startsAt': '2030-11-01T00:00:00Z',
      'impact': {},
    },
  ],
  'platform': [
    {
      'code': 'DELIGRO10',
      'kind': 'percent',
      'value': 10,
      'maxDiscount': 40,
      'shopOnly': false,
      'impact': {'orders': 3, 'sales': 900},
    },
  ],
};

Map<String, dynamic> reviewsJson() => {
  'average': 4.3,
  'count': 27,
  'reviews': [
    {
      'id': _uuid,
      'orderCode': '#A1B2C3',
      'rating': 5,
      'comment': 'Best paneer in town',
      'createdAt': '2026-10-20T08:00:00Z',
      'details': [],
      'reply': null,
    },
    {
      'id': 'bb22bb22-0000-0000-0000-000000000002',
      'orderCode': '#D4E5F6',
      'rating': 2,
      'comment': 'Cold',
      'createdAt': '2026-10-19T08:00:00Z',
      'details': [],
      'reply': {'text': 'Sorry!'},
    },
  ],
  'stars': [
    {'stars': 5, 'count': 1},
    {'stars': 4, 'count': 0},
    {'stars': 3, 'count': 0},
    {'stars': 2, 'count': 1},
    {'stars': 1, 'count': 0},
  ],
  'insights': {
    'customers': 40,
    'repeatCustomers': 14,
    'repeatRate': 35,
    'ordersPerCustomer': 1.8,
    'averageOrderValue': 312,
    'daysBetweenOrders': 6.5,
    'topCustomers': [
      {'name': 'Asha V.', 'orders': 7, 'spent': 2400, 'lastOrderAt': '2026-10-20T08:00:00Z'},
    ],
  },
  'days': 90,
};

Map<String, dynamic> marketingJson(String status) => {
  'id': _uuid,
  'number': 4,
  'kind': 'banner',
  'title': 'Diwali banner',
  'details': 'Home banner for Diwali week.',
  'budget': 2000,
  'startsOn': '2026-11-01',
  'endsOn': '2026-11-07',
  'status': status,
  'adminRemarks': status == 'rejected' ? 'Slots are full' : null,
  'createdAt': '2026-10-20T08:00:00Z',
  'updates': [
    {'status': 'pending', 'by': 'you', 'at': '2026-10-20T08:00:00Z'},
  ],
};

Map<String, dynamic> inboxJson({int unread = 1}) => {
  'available': true,
  'unread': unread,
  'hasMore': false,
  'announcements': [
    {'id': 'x', 'title': 'Payouts move to Tuesdays', 'body': 'From next week.'},
  ],
  'items': [
    {
      'id': _uuid,
      'category': 'payments',
      'title': 'Payment sent 💸',
      'body': 'Ref UTR1',
      'data': {'url': '/payments/$_uuid'},
      'read': false,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    },
    {
      'id': 'bb22bb22-0000-0000-0000-000000000002',
      'category': 'orders',
      'title': 'New order 🔔',
      'body': '#A1',
      'data': {},
      'read': true,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    },
  ],
};

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
    registerFallbackValue(Offer(code: 'X', kind: 'flat', value: 1));
    registerFallbackValue(<String, Object?>{});
  });

  late MockGrowthRepo repo;
  setUp(() {
    repo = MockGrowthRepo();
    when(() => repo.inbox(before: any(named: 'before'))).thenAnswer((_) async => Inbox.fromJson(inboxJson()));
  });

  Future<void> open(WidgetTester t, Widget screen) async {
    await pumpPartner(
      t,
      child: screen,
      overrides: [growthRepoProvider.overrideWithValue(repo), vendorMeProvider.overrideWith(() => FixedMe(fakeMe()))],
    );
    await t.pumpAndSettle();
  }

  test('push taps open only allowed app screens', () {
    expect(vendorPathFrom(null, {'url': '/payments/$_uuid'}), '/payments/$_uuid');
    expect(vendorPathFrom(null, {'url': '/more/support/$_uuid'}), '/more/support/$_uuid');
    expect(vendorPathFrom(null, {'url': '/more/reviews'}), '/more/reviews');
    expect(vendorPathFrom(null, {'url': '/more/settings'}), isNull);
    expect(vendorPathFrom('https://evil.example/x', null), isNull);
    expect(vendorPathFrom(null, {'ringId': 'vendor:$_uuid'}), '/orders/$_uuid');
  });

  test('an offer reads like its badge', () {
    final o = Offer.fromJson(offersJson()['own'][0]);
    expect(o.headline, '20% OFF up to ₹80 over ₹199');
    expect(Offer(code: 'F', kind: 'flat', value: 50).headline, '₹50 OFF');
  });

  testPartner('offers: own codes with impact, Deligro promotions, pause', (t) async {
    when(repo.offers).thenAnswer((_) async => OffersState.fromJson(offersJson()));
    when(() => repo.setOfferActive(any(), any())).thenAnswer((_) async {});
    await open(t, const OffersScreen());
    expect(find.text('SPICE20'), findsOneWidget);
    expect(find.text('12 orders · ₹5,400 sales · ₹720 given'), findsOneWidget);
    expect(find.text('Scheduled'), findsOneWidget);
    await t.scrollUntilVisible(find.text('DELIGRO10'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Every shop'), findsOneWidget);
    await t.scrollUntilVisible(find.text('SPICE20'), -300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.byType(Switch).first);
    await t.pumpAndSettle();
    verify(() => repo.setOfferActive('SPICE20', false)).called(1);
  });

  testPartner('a new offer: 50% needs a cap, then it is created uppercase', (t) async {
    when(() => repo.createOffer(any())).thenAnswer((_) async {});
    await open(t, const OfferEditorScreen());
    await t.enterText(find.widgetWithText(TextFormField, 'Code'), 'half50');
    await t.enterText(find.widgetWithText(TextFormField, 'Discount (%)'), '50');
    await t.tap(find.text('Create offer'));
    await t.pumpAndSettle();
    expect(find.text('Set a cap for 50% or more'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'Up to (₹)'), '100');
    await t.tap(find.text('Create offer'));
    await t.pumpAndSettle();
    final sent = verify(() => repo.createOffer(captureAny())).captured.single as Offer;
    expect(sent.code, 'HALF50');
    expect(sent.toJson()['maxDiscount'], 100);
    expect(sent.toJson()['maxPerCustomer'], 1);
  });

  testPartner('reviews: rating, breakdown, reply; customers tab', (t) async {
    when(() => repo.reviews(days: any(named: 'days'))).thenAnswer((_) async => ReviewsState.fromJson(reviewsJson()));
    when(() => repo.reply(any(), any())).thenAnswer((_) async {});
    await open(t, const ReviewsScreen());
    expect(find.text('4.3'), findsOneWidget);
    expect(find.text('Best paneer in town'), findsOneWidget);
    expect(find.text('You: Sorry!'), findsOneWidget);
    await t.tap(find.text('Reply').first);
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).last, 'Thank you!');
    await t.tap(find.text('Post reply'));
    await t.pumpAndSettle();
    verify(() => repo.reply(_uuid, 'Thank you!')).called(1);
    await t.tap(find.text('Customers'));
    await t.pumpAndSettle();
    expect(find.text('14 · 35%'), findsOneWidget);
    expect(find.text('Asha V.'), findsOneWidget);
    expect(find.textContaining('+91'), findsNothing);
  });

  testPartner('marketing: send a request', (t) async {
    when(() => repo.requestMarketing(any())).thenAnswer((_) async {});
    when(repo.marketing).thenAnswer((_) async => []);
    await open(t, const NewMarketingScreen(kind: 'discount_offer'));
    await t.enterText(find.widgetWithText(TextFormField, 'Title'), 'Weekend offer');
    await t.enterText(find.widgetWithText(TextFormField, 'Details'), 'Please run a weekend discount banner for us.');
    await t.tap(find.text('Send request'));
    await t.pumpAndSettle();
    final body = verify(() => repo.requestMarketing(captureAny())).captured.single as Map<String, Object?>;
    expect(body['kind'], 'discount_offer');
    expect(body['title'], 'Weekend offer');
    expect(body['budget'], isNull);
  });

  testPartner('marketing: a pending request can be withdrawn; a rejected one shows why', (t) async {
    when(repo.marketing).thenAnswer((_) async => [MarketingRequest.fromJson(marketingJson('rejected'))]);
    await open(t, const MarketingDetailScreen(id: _uuid));
    expect(find.text('Deligro: Slots are full'), findsOneWidget);
    expect(find.text('Withdraw request'), findsNothing);
  });

  testPartner('support: a new ticket goes up and opens its thread', (t) async {
    final orders = MockOrdersRepo();
    when(orders.board).thenAnswer((_) async => []);
    when(() => repo.openTicket(any())).thenAnswer((_) async => _uuid);
    when(() => repo.ticket(_uuid)).thenAnswer(
      (_) async => TicketThread.fromJson({
        'ticket': {'id': _uuid, 'number': 12, 'category': 'payments', 'subject': 'Payout missing', 'status': 'open'},
        'messages': [
          {'id': 'm1', 'body': 'Last week not paid', 'fromYou': true, 'attachments': []},
        ],
      }),
    );
    when(repo.tickets).thenAnswer((_) async => []);
    final c = await pumpPartner(
      t,
      router: (ref) => ref.watch(routerProvider),
      overrides: [...ordersOverrides(orders), growthRepoProvider.overrideWithValue(repo)],
    );
    c.read(routerProvider).push('/more/support/new');
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextFormField, 'Subject'), 'Payout missing');
    await t.enterText(find.widgetWithText(TextFormField, 'Tell us what happened'), 'Last week not paid');
    await t.tap(find.text('Send to Deligro'));
    await t.pumpAndSettle();
    final body = verify(() => repo.openTicket(captureAny())).captured.single as Map<String, Object?>;
    expect(body['category'], 'payments');
    expect(body['attachments'], isEmpty);
    expect(find.text('#12'), findsOneWidget);
    expect(find.text('Last week not paid'), findsOneWidget);
  });

  testPartner('notifications: announcement pinned, unread marked, tap marks read', (t) async {
    when(() => repo.markRead(any())).thenAnswer((_) async {});
    when(repo.markAllRead).thenAnswer((_) async {});
    await open(t, const NotificationsScreen());
    expect(find.text('Payouts move to Tuesdays'), findsOneWidget);
    expect(find.text('TODAY'), findsOneWidget);
    expect(find.text('Mark all read'), findsOneWidget);
    await t.tap(find.text('Mark all read'));
    await t.pumpAndSettle();
    verify(repo.markAllRead).called(1);
  });
}
