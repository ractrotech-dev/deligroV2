import 'package:deligro_manager/features/shell/nav.dart';
import 'package:deligro_manager/models/dashboard.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/dashboard.dart';
import 'package:deligro_manager/models/stats.dart';
import 'package:deligro_manager/state/stats.dart';
import 'package:deligro_manager/router.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:deligro_manager/widgets/phase_placeholder.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_test.dart' show meJson;
import 'helpers.dart';
import 'stats_fixture.dart';

class _FixedMe extends ManagerMeNotifier {
  _FixedMe(this.me);
  final ManagerMe me;
  @override
  Future<ManagerMe?> build() async => me;
}

/// Home's figures without the network or the 30-second timer — these tests
/// are about navigation (dashboard_test.dart covers the dashboard).
class _FixedDashboard extends DashboardNotifier {
  @override
  Future<DashboardData> build() async => DashboardData.fromJson(const {'order': [], 'figures': {}, 'unavailable': []});
}

ManagerMe _me({Map<String, bool> perms = const {}, bool noZones = false}) => ManagerMe.fromJson({
      ...meJson,
      'permissions': {
        for (final t in tabs) if (t.permission != null) t.permission!: true,
        for (final m in moreItems) if (m.permission != null) m.permission!: true,
        ...perms,
      },
      if (noZones) 'zones': {'all': false, 'cities': []},
    });

/// The whole router, signed in as [me], starting at [at].
Future<void> _pumpApp(WidgetTester tester, ManagerMe me, {String at = '/'}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    signedInProvider.overrideWithValue(true),
    managerMeProvider.overrideWith(() => _FixedMe(me)),
    dashboardProvider.overrideWith(_FixedDashboard.new),
    statsProvider.overrideWith((_) async => StatsData.fromJson(statsJson())),
  ]);
  addTearDown(container.dispose);
  await container.read(managerMeProvider.future);
  final router = container.read(routerProvider);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router),
  ));
  router.go(at);
  await tester.pumpAndSettle();
}

void main() {
  group('navigation rules', () {
    test('Finance is not a tab without manager.finance.view', () {
      final without = tabsFor(_me(perms: {'manager.finance.view': false})).map((t) => t.path);
      expect(without, isNot(contains('/finance')));
      expect(tabsFor(_me()).map((t) => t.path), contains('/finance'));
    });

    test('More hides the rows a person may not open', () {
      final items = moreItemsFor(_me(perms: {'manager.vendors.view': false, 'manager.audit.view_zone': false}));
      final paths = items.map((m) => m.path);
      expect(paths, isNot(contains('/more/vendors')));
      expect(paths, isNot(contains('/more/audit')));
      expect(paths, contains('/more/profile'));
      expect(paths, contains('/more/settings'));
    });

    test('sub-paths need their parent screen\'s permission', () {
      expect(permissionFor('/more/vendors/abc'), 'manager.vendors.view');
      expect(permissionFor('/more/vendors/new'), 'manager.vendors.onboard');
      expect(permissionFor('/orders/123'), 'manager.orders.view');
      expect(permissionFor('/more/profile/sessions'), isNull);
    });

    test('a screen whose permission is off redirects home', () {
      final me = _me(perms: {'manager.finance.view': false});
      expect(gateRedirect(signedIn: true, me: AsyncData(me), path: '/finance'), '/');
      expect(gateRedirect(signedIn: true, me: AsyncData(_me()), path: '/finance'), isNull);
    });
  });

  testWidgets('Home opens Statistics for a manager with reports', (tester) async {
    await _pumpApp(tester, _me());
    await tester.tap(find.byKey(const Key('home-statistics')));
    await tester.pumpAndSettle();
    expect(find.text('Statistics'), findsWidgets);
    expect(find.byKey(const Key('period-month')), findsOneWidget);
  });

  testWidgets('Home has no Statistics row without the reports permission', (tester) async {
    await _pumpApp(tester, _me(perms: {'manager.reports.view': false}));
    expect(find.byKey(const Key('home-statistics')), findsNothing);
  });

  testWidgets('the tab bar leaves out Finance for a manager without it', (tester) async {
    await _pumpApp(tester, _me(perms: {'manager.finance.view': false}));
    final bar = find.byKey(const Key('manager-tabs'));
    expect(find.descendant(of: bar, matching: find.text('Finance')), findsNothing);
    expect(find.descendant(of: bar, matching: find.text('Orders')), findsOneWidget);
  });

  testWidgets('the tab bar shows all five for a manager with every view', (tester) async {
    await _pumpApp(tester, _me());
    final bar = find.byKey(const Key('manager-tabs'));
    for (final label in ['Home', 'Orders', 'Live', 'Finance', 'More']) {
      expect(find.descendant(of: bar, matching: find.text(label)), findsOneWidget);
    }
  });

  testWidgets('Home tells a manager with no zones so', (tester) async {
    await _pumpApp(tester, _me(noZones: true));
    expect(find.byKey(const Key('no-zones')), findsOneWidget);
  });

  testWidgets('Home has no warning when zones are assigned', (tester) async {
    await _pumpApp(tester, _me());
    expect(find.byKey(const Key('no-zones')), findsNothing);
    expect(find.byKey(const Key('zone-picker')), findsOneWidget);
  });

  testWidgets('a placeholder names the phase that delivers it', (tester) async {
    await tester.pumpWidget(await themed(const PhasePlaceholder(title: 'Vendors', icon: Icons.store, phase: 4)));
    expect(find.text('Arrives in build phase 4.'), findsOneWidget);
  });

  testWidgets('More lists only permitted rows and opens their placeholder', (tester) async {
    await _pumpApp(tester, _me(perms: {'manager.vendors.view': false}), at: '/more');
    expect(find.byKey(const Key('more-/more/vendors')), findsNothing);
    await tester.tap(find.byKey(const Key('more-/more/riders')));
    await tester.pumpAndSettle();
    expect(find.text('Arrives in build phase 5.'), findsOneWidget);
  });
}
