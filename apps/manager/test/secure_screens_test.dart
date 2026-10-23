// Finance and customer screens are kept out of screenshots and the recents
// thumbnail. The flag follows the screen on top, however it was reached.
import 'package:deligro_manager/core/secure_screens.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/features/shell/nav.dart';
import 'package:deligro_manager/router.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_test.dart' show meJson;

class _FakeChannel implements SecureChannel {
  final calls = <bool>[];
  @override
  Future<void> setSecure(bool secure) async => calls.add(secure);
}

class _FixedMe extends ManagerMeNotifier {
  _FixedMe(this.me);
  final ManagerMe me;
  @override
  Future<ManagerMe?> build() async => me;
}

/// Every route path the real router declares, joined from its nested parts.
List<String> _declaredPaths(List<RouteBase> routes, [String parent = '']) {
  final out = <String>[];
  for (final r in routes) {
    if (r is GoRoute) {
      final full = r.path.startsWith('/') ? r.path : '${parent == '/' ? '' : parent}/${r.path}';
      out.add(full);
      out.addAll(_declaredPaths(r.routes, full));
    } else {
      out.addAll(_declaredPaths(r.routes, parent));
    }
  }
  return out;
}

/// A small router with the shapes that matter: a plain screen, a secure list,
/// a secure detail pushed on top, and a sensitive pane inside an ordinary screen.
GoRouter _mini() => GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(path: '/', builder: (_, _) => const Text('home')),
        GoRoute(path: '/orders', builder: (_, _) => const Text('orders')),
        GoRoute(path: '/finance', builder: (_, _) => const Text('finance')),
        GoRoute(path: '/more/customers/:id', builder: (_, s) => Text('customer ${s.pathParameters['id']}')),
        GoRoute(
          path: '/more/vendors/:id',
          builder: (_, _) => const Column(children: [Text('overview'), SecureScope(child: Text('finance tab'))]),
        ),
      ],
    );

Future<(GoRouter, _FakeChannel, SecureScreenController)> _started(WidgetTester tester, {String at = '/'}) async {
  final router = _mini();
  final channel = _FakeChannel();
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  router.go(at);
  await tester.pumpAndSettle();
  final controller = SecureScreenController(router: router, channel: channel)..start();
  addTearDown(controller.dispose);
  return (router, channel, controller);
}

void main() {
  group('which locations are secure', () {
    test('every finance and customer area, and everything under it', () {
      for (final path in [
        '/finance',
        '/finance/vendor-dues',
        '/finance/settlements/abc',
        '/more/customers',
        '/more/customers/c1',
        '/more/customers/retention',
        '/more/approvals',
        '/more/reports',
        '/more/reports/sales',
        '/more/cash',
        '/more/riders/r1/ledger',
        '/more/customers?q=asha',
      ]) {
        expect(isSecureLocation(path), isTrue, reason: path);
      }
    });

    test('ordinary screens are not', () {
      for (final path in ['/', '/orders', '/orders/o1', '/live', '/stats', '/more', '/more/vendors/v1', '/more/riders/r1', '/more/riders', '/more/support', '/finance-not', '/more/customersx']) {
        expect(isSecureLocation(path), isFalse, reason: path);
      }
    });
  });

  test('every listed pattern points at a screen the router really has', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final all = {
      for (final t in tabs) if (t.permission != null) t.permission!: true,
      for (final m in moreItems) if (m.permission != null) m.permission!: true,
    };
    final container = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      signedInProvider.overrideWithValue(true),
      managerMeProvider.overrideWith(() => _FixedMe(ManagerMe.fromJson({...meJson, 'permissions': all}))),
    ]);
    addTearDown(container.dispose);
    final router = container.read(routerProvider);
    final paths = _declaredPaths(router.configuration.routes);
    expect(paths, isNotEmpty);
    for (final pattern in securePatterns) {
      expect(paths.any((p) => patternMatchesRoute(pattern, p)), isTrue, reason: 'no route matches $pattern; routes: ${paths.join(', ')}');
    }
  });

  group('the flag follows the screen on top', () {
    testWidgets('opening Finance sets it, leaving clears it', (tester) async {
      final (router, channel, _) = await _started(tester);
      expect(channel.calls, isEmpty, reason: 'Home is not secure and nothing was set before');
      router.go('/finance');
      await tester.pumpAndSettle();
      expect(channel.calls, [true]);
      router.go('/orders');
      await tester.pumpAndSettle();
      expect(channel.calls, [true, false]);
    });

    testWidgets('a deep link straight into a customer, from a cold start, sets it first', (tester) async {
      final (_, channel, controller) = await _started(tester, at: '/more/customers/c1');
      expect(channel.calls, [true]);
      expect(controller.secure, isTrue);
    });

    testWidgets('going back from a customer to Orders clears it', (tester) async {
      final (router, channel, _) = await _started(tester, at: '/more/customers/c1');
      router.go('/orders');
      await tester.pumpAndSettle();
      expect(channel.calls, [true, false]);
    });

    testWidgets('moving between two secure screens does not flicker the flag', (tester) async {
      final (router, channel, _) = await _started(tester, at: '/finance');
      router.go('/more/customers/c9');
      await tester.pumpAndSettle();
      expect(channel.calls, [true], reason: 'secure -> secure is one call, not off then on');
    });

    testWidgets('sensitive content inside an ordinary screen sets it while it is on screen (tablet pane, finance tab)', (tester) async {
      final (router, channel, _) = await _started(tester, at: '/orders');
      expect(channel.calls, isEmpty);
      router.go('/more/vendors/v1');
      await tester.pumpAndSettle();
      expect(channel.calls, [true], reason: 'the Finance tab is a SecureScope');
      router.go('/orders');
      await tester.pumpAndSettle();
      expect(channel.calls, [true, false]);
    });

    testWidgets('a secure route and a secure pane together clear only when both are gone', (tester) async {
      final (router, channel, _) = await _started(tester, at: '/finance');
      expect(channel.calls, [true]);
      secureScopeCount.value++; // a pane appears on the secure screen
      await tester.pump();
      expect(channel.calls, [true], reason: 'already secure');
      router.go('/orders');
      await tester.pumpAndSettle();
      expect(channel.calls, [true], reason: 'the pane still holds it');
      secureScopeCount.value--;
      await tester.pump();
      expect(channel.calls, [true, false]);
    });

    testWidgets('a disposed controller stops touching the window', (tester) async {
      final (router, channel, controller) = await _started(tester);
      controller.dispose();
      router.go('/finance');
      await tester.pumpAndSettle();
      expect(channel.calls, isEmpty);
    });
  });
}
