import 'package:deligro_manager/core/entity_routes.dart';
import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/alerts/alerts_screen.dart';
import 'package:deligro_manager/features/inbox/inbox_screen.dart';
import 'package:deligro_manager/features/profile/account_screens.dart';
import 'package:deligro_manager/models/account.dart';
import 'package:deligro_manager/models/alerts.dart';
import 'package:deligro_manager/models/inbox.dart';
import 'package:deligro_manager/state/account.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/widgets/alert_bell.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'fakes/fake_ops_repositories.dart';
import 'vp_helpers.dart';

List _ops({FakeAlertsRepository? alerts, FakeInboxRepository? inbox}) => [
      alertsRepoProvider.overrideWithValue(alerts ?? FakeAlertsRepository()),
      inboxRepoProvider.overrideWithValue(inbox ?? FakeInboxRepository()),
    ];

class _Prefs extends NotificationPrefsNotifier {
  @override
  Future<List<AlertKindPref>> build() async => const [
        AlertKindPref(kind: 'order_unassigned', en: 'Unassigned orders', push: true),
        AlertKindPref(kind: 'incident', en: 'Incidents', push: true, locked: true),
      ];
}

void main() {
  group('alerts', () {
    testWidgets('open alerts list critical first, with counts on the segments', (tester) async {
      await pumpVp(tester, const AlertsScreen(), extra: _ops());
      await tester.pumpAndSettle();
      expect(find.text('Open (2)'), findsOneWidget);
      expect(find.text('Acknowledged (1)'), findsOneWidget);
      final failed = tester.getTopLeft(find.text('Delivery failed for XY98ZW76')).dy;
      final unassigned = tester.getTopLeft(find.text('Order AB12CD34 has no rider')).dy;
      expect(failed < unassigned, isTrue);
      expect(find.textContaining('Reopened 1 time'), findsOneWidget);
    });

    testWidgets('Acknowledge moves the alert to Acknowledged', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertsScreen(), extra: _ops(alerts: fake));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alert-ack-al-2')));
      await tester.pumpAndSettle();
      expect(fake.actCalls.single.$2.action, 'acknowledge');
      expect(find.text('Order AB12CD34 has no rider'), findsNothing);
      expect(find.text('Acknowledged (2)'), findsOneWidget);
    });

    testWidgets('Resolve needs a note', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertsScreen(), extra: _ops(alerts: fake));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alert-resolve-al-1')));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Customer refunded');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      final (id, a) = fake.actCalls.single;
      expect(id, 'al-1');
      expect(a.action, 'resolve');
      expect(a.note, 'Customer refunded');
    });

    testWidgets('raising an incident sends title, details, severity and zone', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertsScreen(), extra: _ops(alerts: fake), size: const Size(400, 900));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alerts-raise-incident')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('incident-title')), 'Payment gateway down');
      await tester.enterText(find.byKey(const Key('incident-body')), 'Online checkouts fail since 9:40.');
      await tester.tap(find.byKey(const Key('incident-severity-critical')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('incident-submit')));
      await tester.pumpAndSettle();
      final d = fake.incidentCalls.single;
      expect(d.title, 'Payment gateway down');
      expect(d.severity, AlertSeverity.critical);
      expect(d.zoneId, 'z1');
    });

    testWidgets('the list stops asking while it is not on screen', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const TickerMode(enabled: false, child: AlertsScreen()), extra: _ops(alerts: fake));
      await tester.pumpAndSettle();
      final before = fake.listCalls.length;
      await tester.pump(const Duration(seconds: 40));
      expect(fake.listCalls.length, before);
    });

    testWidgets('while on screen it asks again every 15 s', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertsScreen(), extra: _ops(alerts: fake));
      await tester.pumpAndSettle();
      final before = fake.listCalls.length;
      await tester.pump(const Duration(seconds: 16));
      await tester.pump();
      expect(fake.listCalls.length, greaterThan(before));
    });
  });

  group('entity routes', () {
    test('every entity type opens the right screen', () {
      expect(routeForEntity('order', 'o-1', alertId: 'a'), '/orders/o-1');
      expect(routeForEntity('delivery', 'd-1', data: {'orderId': 'o-2'}, alertId: 'a'), '/orders/o-2');
      expect(routeForEntity('delivery', 'o-7', alertId: 'a'), '/orders/o-7');
      expect(routeForEntity('restaurant', 'v-1', alertId: 'a'), '/more/vendors/v-1');
      expect(routeForEntity('rider', 'r-1', alertId: 'a'), '/more/riders/r-1');
      expect(routeForEntity('ticket', 't-1', alertId: 'a'), '/more/tickets/t-1');
      expect(routeForEntity('marketing_request', 'm-1', alertId: 'a'), '/more/marketing/requests/m-1');
      expect(routeForEntity('settlement', 's-1', alertId: 'a'), '/finance/settlements/s-1');
      expect(routeForEntity('payment_request', 'p-1', alertId: 'a'), '/more/approvals?id=p-1');
      expect(routeForEntity('cash_day', 'r-1:2026-10-21', alertId: 'a'), '/more/cash');
      expect(routeForEntity('zone', 'z-1', alertId: 'al-9'), '/alerts/al-9');
      expect(routeForEntity('incident', 'manual:x', alertId: 'al-9'), '/alerts/al-9');
      expect(routeForEntity('wormhole', 'x', alertId: 'al-9'), '/alerts/al-9');
      expect(routeForEntity('wormhole', 'x'), '/alerts');
    });

    test('alert, ticket and inbox pushes route; unknown types open the inbox', () {
      const id = '7b0f2c1e-1111-4222-8333-444455556666';
      expect(inAppPathFrom(null, {'type': 'alert', 'id': id}), '/alerts/$id');
      expect(inAppPathFrom(null, {'type': 'ticket', 'id': id}), '/more/tickets/$id');
      expect(inAppPathFrom(null, {'type': 'inbox', 'url': '/orders/$id'}), '/orders/$id');
      expect(inAppPathFrom(null, {'type': 'something_new', 'id': id}), '/inbox');
      expect(inAppPathFrom('/alerts/$id', null), '/alerts/$id');
      expect(inAppPathFrom('/inbox', null), '/inbox');
    });
  });

  group('bell and inbox', () {
    testWidgets('the bell shows the unread count and a red dot for critical alerts', (tester) async {
      await pumpVp(tester, const Scaffold(body: Center(child: AlertBell())), extra: _ops());
      await tester.pumpAndSettle();
      expect(find.text('7'), findsOneWidget);
      expect(find.byKey(const Key('alert-bell-critical')), findsOneWidget);
    });

    testWidgets('no critical alerts, no red dot', (tester) async {
      final inbox = FakeInboxRepository(count: const UnreadCount(unread: 2));
      await pumpVp(tester, const Scaffold(body: Center(child: AlertBell())), extra: _ops(inbox: inbox));
      await tester.pumpAndSettle();
      expect(find.text('2'), findsOneWidget);
      expect(find.byKey(const Key('alert-bell-critical')), findsNothing);
    });

    testWidgets('tapping an inbox item marks it read and opens its link', (tester) async {
      final inbox = FakeInboxRepository();
      final router = GoRouter(initialLocation: '/inbox', routes: [
        GoRoute(path: '/inbox', builder: (_, _) => const InboxScreen()),
        GoRoute(path: '/orders/:id', builder: (_, s) => Text('order ${s.pathParameters['id']}')),
        GoRoute(path: '/alerts', builder: (_, _) => const Text('alerts list')),
      ]);
      await pumpVpRouter(tester, router, overrides: [...vpOverrides(), ..._ops(inbox: inbox)]);
      await tester.pumpAndSettle();
      expect(find.textContaining('5 open'), findsOneWidget);
      await tester.tap(find.text('Order AB12CD34 has no rider'));
      await tester.pumpAndSettle();
      expect(inbox.markCalls.single.$1, ['n-1']);
      expect(find.text('order o-1'), findsOneWidget);
    });

    testWidgets('Mark all read', (tester) async {
      final inbox = FakeInboxRepository();
      await pumpVp(tester, const InboxScreen(), extra: _ops(inbox: inbox));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('inbox-mark-all')));
      await tester.pumpAndSettle();
      expect(inbox.markCalls.single.$2, isTrue);
    });
  });

  testWidgets('locked kinds show as always delivered and cannot be switched off', (tester) async {
    await pumpVp(tester, const NotificationPrefsScreen(), extra: [notificationPrefsProvider.overrideWith(_Prefs.new)]);
    await tester.pumpAndSettle();
    final locked = tester.widget<SwitchListTile>(find.byKey(const Key('pref-incident')));
    expect(locked.value, isTrue);
    expect(locked.onChanged, isNull);
    expect(find.text('Always delivered'), findsOneWidget);
    final open = tester.widget<SwitchListTile>(find.byKey(const Key('pref-order_unassigned')));
    expect(open.onChanged, isNotNull);
  });
}
