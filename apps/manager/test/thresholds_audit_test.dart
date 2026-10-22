import 'package:deligro_manager/features/alerts/alert_thresholds_screen.dart';
import 'package:deligro_manager/features/audit/audit_entry_screen.dart';
import 'package:deligro_manager/features/audit/audit_log_screen.dart';
import 'package:deligro_manager/features/shell/nav.dart';
import 'package:deligro_manager/models/audit.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_ops_repositories.dart';
import 'vp_helpers.dart';

const _configure = {'manager.alerts.configure'};
const _auditor = {'manager.audit.view_zone', 'manager.support.manage'};

List _ops({FakeAlertsRepository? alerts, FakeAuditRepository? audit}) => [
      alertsRepoProvider.overrideWithValue(alerts ?? FakeAlertsRepository()),
      auditRepoProvider.overrideWithValue(audit ?? FakeAuditRepository()),
    ];

void main() {
  group('alert thresholds', () {
    testWidgets('a threshold outside its unit bounds says what is allowed', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertThresholdsScreen(),
          permissions: _configure, extra: _ops(alerts: fake), size: const Size(400, 1600));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('rule-threshold-order_unassigned')), '0');
      await tester.pump();
      expect(find.text('1–1440'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('thresholds-save'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('rule-threshold-order_unassigned')), '7');
      await tester.pump();
      await tester.tap(find.byKey(const Key('thresholds-save')));
      await tester.pumpAndSettle();
      final c = fake.setRuleCalls.single;
      expect(c.kind, 'order_unassigned');
      expect(c.threshold, 7);
      expect(c.zoneId, 'z1');
    });

    testWidgets('inherited rows say so and have no Reset; overridden rows do', (tester) async {
      await pumpVp(tester, const AlertThresholdsScreen(),
          permissions: _configure, extra: _ops(), size: const Size(400, 1600));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('rule-inherited-order_unassigned')), findsOneWidget);
      expect(find.byKey(const Key('rule-reset-order_unassigned')), findsNothing);
      expect(find.byKey(const Key('rule-reset-high_cancellation_rate')), findsOneWidget);
    });

    testWidgets('Reset sends the zone and kind', (tester) async {
      final fake = FakeAlertsRepository();
      await pumpVp(tester, const AlertThresholdsScreen(),
          permissions: _configure, extra: _ops(alerts: fake), size: const Size(400, 1600));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('rule-reset-high_cancellation_rate')));
      await tester.pumpAndSettle();
      expect(fake.resetCalls.single, ('high_cancellation_rate', 'z1'));
    });

    testWidgets('without Configure alerts every field is read only and says who to ask', (tester) async {
      await pumpVp(tester, const AlertThresholdsScreen(), permissions: const {}, extra: _ops(), size: const Size(400, 1600));
      await tester.pumpAndSettle();
      expect(find.text('Ask an admin to give you Configure alerts.'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const Key('rule-threshold-order_unassigned'))).enabled, isFalse);
      expect(tester.widget<Switch>(find.byKey(const Key('rule-enabled-order_unassigned'))).onChanged, isNull);
      expect(find.byKey(const Key('thresholds-save')), findsNothing);
    });
  });

  group('audit log', () {
    testWidgets('entries list with who, what, the entity and the reason', (tester) async {
      await pumpVp(tester, const AuditLogScreen(), permissions: _auditor, extra: _ops());
      await tester.pumpAndSettle();
      expect(find.text('Rider reassigned'), findsOneWidget);
      expect(find.textContaining('Ravi Kumar · Manager'), findsOneWidget);
      expect(find.textContaining('Rider bike broke down'), findsOneWidget);
      expect(find.text('Vendor status changed'), findsOneWidget);
    });

    testWidgets('picking a group whose codes share a prefix filters by that prefix', (tester) async {
      final audit = FakeAuditRepository();
      await pumpVp(tester, const AuditLogScreen(), permissions: _auditor, extra: _ops(audit: audit), size: const Size(400, 1000));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('audit-filters')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('af-group-Vendors')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('af-apply')));
      await tester.pumpAndSettle();
      expect(audit.listCalls.last.action, 'vendor.*');
    });

    testWidgets('a group with mixed codes filters by the action picked in it', (tester) async {
      final audit = FakeAuditRepository();
      await pumpVp(tester, const AuditLogScreen(), permissions: _auditor, extra: _ops(audit: audit), size: const Size(400, 1000));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('audit-filters')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('af-group-Orders')));
      await tester.pump();
      expect(find.text('Pick an action in this group'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('af-action-delivery.reassign')));
      await tester.tap(find.byKey(const Key('af-action-delivery.reassign')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('af-apply')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('af-apply')));
      await tester.pumpAndSettle();
      expect(audit.listCalls.last.action, 'delivery.reassign');
    });

    testWidgets('an entry shows its before and after as a diff', (tester) async {
      await pumpVp(tester, const AuditEntryScreen(entryId: 1203), permissions: _auditor, extra: _ops());
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('diff-riderId')), findsOneWidget);
      expect(find.byKey(const Key('diff-leg.pickedUp')), findsOneWidget);
      expect(find.text('r-1'), findsOneWidget);
      expect(find.text('r-2'), findsOneWidget);
      expect(find.text('Open order'), findsOneWidget);
    });

    test('the Audit log menu item needs the audit permission', () {
      ManagerMe me(Map<String, bool> perms) => ManagerMe.fromJson({...meJson, 'permissions': perms});
      expect(moreItemsFor(me({})).any((m) => m.path == '/more/audit'), isFalse);
      expect(moreItemsFor(me({'manager.audit.view_zone': true})).any((m) => m.path == '/more/audit'), isTrue);
      expect(moreItemsFor(me({})).any((m) => m.path == '/more/settings/alerts'), isTrue);
    });

    test('a group prefix only when every code in it shares one', () {
      final catalog = AuditActionDef.listFromJson(p8('audit_actions'));
      expect(actionPrefixForGroup('Vendors', catalog), 'vendor.*');
      expect(actionPrefixForGroup('Orders', catalog), isNull);
    });
  });
}
