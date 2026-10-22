// Safety and SOS: the SOS sheet (Call 112, Alert Deligro, emergency contact,
// support), an alert that cannot reach the server and keeps trying, the Safety
// screen and the report forms, and the §15 wording. No network and no phone
// calls: the safety repository is a fake and the URL launcher a recorder.
import 'dart:io';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/sos_queue.dart';
import 'package:deligro_rider/data/safety_repository.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/features/safety/safety_screen.dart';
import 'package:deligro_rider/features/safety/sos_sheet.dart';
import 'package:deligro_rider/models/support.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/safety.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/data/support_repository.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Sent {
  _Sent(this.kind, this.lat, this.lng, this.note, this.photos, this.orderId);
  final SosKind kind;
  final double? lat;
  final double? lng;
  final String? note;
  final int photos;
  final String? orderId;
}

class _Safety implements SafetyRepository {
  _Safety({this.contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780', relation: 'Wife')});

  EmergencyContact? contact;
  Object? error;
  final sent = <_Sent>[];
  final attempts = <_Sent>[];

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) async {
    final s = _Sent(kind, lat, lng, note, photos.length, orderId);
    attempts.add(s);
    final e = error;
    if (e != null) throw e;
    sent.add(s);
    return SosAck(ticketId: 't1', number: 1060, deduped: sent.length > 1);
  }

  @override
  Future<EmergencyContact?> emergencyContact() async => contact;
}

class _Support implements SupportRepository {
  @override
  Future<SupportOverview> overview() async => SupportOverview.fromJson({
        'tickets': const [],
        'contact': {'phone': '+91 98765 43210', 'whatsapp': null},
        'categories': const [],
      });

  @override
  Future<TicketThread> thread(String id) => throw UnimplementedError();

  @override
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  }) => throw UnimplementedError();

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) => throw UnimplementedError();

  @override
  Future<List<RecentOrder>> recentOrders() async => const [];
}

class _Ctx {
  _Ctx(this.container, this.opened, this.router);
  final ProviderContainer container;
  final List<Uri> opened;
  final GoRouter router;
}

Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<_Ctx> _pump(
  WidgetTester tester, {
  String start = '/host',
  _Safety? safety,
  Map<String, Object> prefs = const {},
  ({double lat, double lng})? fix = (lat: 21.7189, lng: 81.5301),
  ({double lat, double lng})? lastKnown,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  List<File> Function(int)? gallery,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 760 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final opened = <Uri>[];
  final router = GoRouter(
    initialLocation: start,
    routes: [
      GoRoute(
        path: '/host',
        builder: (_, _) => const Scaffold(body: Center(child: SosButton())),
      ),
      GoRoute(path: '/more/profile', builder: (_, _) => const Scaffold(body: Text('PROFILE PAGE'))),
      safetyRoute,
    ],
  );
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      safetyRepoProvider.overrideWithValue(safety ?? _Safety()),
      supportRepoProvider.overrideWithValue(_Support()),
      urlOpenerProvider.overrideWithValue((uri) async {
        opened.add(uri);
        return true;
      }),
      lastKnownPositionProvider.overrideWithValue(() async => lastKnown),
      galleryPickerProvider.overrideWithValue((limit) async => gallery?.call(limit) ?? const []),
    ],
  );
  addTearDown(container.dispose);
  if (fix != null) container.read(latestFixProvider.notifier).set((lat: fix.lat, lng: fix.lng, at: DateTime.now()));
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
  return _Ctx(container, opened, router);
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
  await tester.pump(const Duration(milliseconds: 400));
  await _settle(tester, rounds: 2);
}

Future<void> _openSheet(WidgetTester tester) => _tap(tester, find.byKey(const Key('sos-button')));

String _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
    .join('\n');

/// What a claim that emergency services were reached looks like.
final _claim = RegExp(
  r'(emergency services|police|ambulance|fire (brigade|service)|authorities)[^.\n]{0,40}'
  r'(contacted|notified|alerted|called|informed|dispatched|on (the|their) way)'
  r'|(contacted|notified|informed|called)[^.\n]{0,25}(emergency services|police|ambulance|authorities)'
  r'|help is on (the|its) way',
  caseSensitive: false,
);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('SosQueue', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('a confirmed alert is sent, once, and leaves nothing waiting', () async {
      final repo = _Safety();
      final q = SosQueue(repo, prefs);
      addTearDown(q.dispose);
      final s = await q.alert(lat: 21.7, lng: 81.5);
      expect(s.phase, SosPhase.sent);
      expect(s.ack!.ticketId, 't1');
      expect(repo.sent.single.kind, SosKind.alert);
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.7, 81.5));
      expect(q.waiting, isEmpty);
    });

    test('no connection: queued, kept on the phone, never "sent"', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = SosQueue(repo, prefs, retryEvery: const Duration(hours: 1));
      addTearDown(q.dispose);
      final s = await q.alert(lat: 21.7, lng: 81.5);
      expect(s.phase, SosPhase.queued);
      expect(repo.sent, isEmpty);
      expect(q.waiting, hasLength(1));
      expect(prefs.getString(SosQueue.key), contains('21.7'));
    });

    test('every kind of failure to confirm stays queued: 5xx, 429, 401', () async {
      for (final status in [500, 503, 429, 401]) {
        final repo = _Safety()..error = ApiException(status, 'x');
        final q = SosQueue(repo, prefs, retryEvery: const Duration(hours: 1));
        addTearDown(q.dispose);
        expect((await q.alert()).phase, SosPhase.queued, reason: '$status');
      }
    });

    test('it retries on its beat and sends with the newest position', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      var here = (lat: 21.0, lng: 81.0);
      final q = SosQueue(repo, prefs, retryEvery: const Duration(milliseconds: 40), position: () => here);
      addTearDown(q.dispose);
      await q.alert();
      expect(q.current.phase, SosPhase.queued);
      repo.error = null;
      here = (lat: 21.5, lng: 81.5);
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(q.current.phase, SosPhase.sent);
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.5, 81.5));
      expect(q.waiting, isEmpty);
    });

    test('an alert saved before the app was closed is tried again by the next queue', () async {
      final down = _Safety()..error = ApiException(0, 'network');
      final first = SosQueue(down, prefs, retryEvery: const Duration(hours: 1));
      await first.alert(lat: 21.7, lng: 81.5, orderId: 'o1');
      first.dispose();

      final up = _Safety();
      final second = SosQueue(up, prefs, retryEvery: const Duration(hours: 1));
      addTearDown(second.dispose);
      expect(second.current.phase, SosPhase.queued);
      await second.flush();
      expect(second.current.phase, SosPhase.sent);
      expect(up.sent.single.orderId, 'o1');
      expect((up.sent.single.lat, up.sent.single.lng), (21.7, 81.5));
    });

    test('a refusal (400) is dropped, not retried for ever', () async {
      final repo = _Safety()..error = ApiException(400, 'invalid_kind');
      final q = SosQueue(repo, prefs, retryEvery: const Duration(milliseconds: 20));
      addTearDown(q.dispose);
      expect((await q.alert()).phase, SosPhase.refused);
      expect(q.waiting, isEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(repo.attempts, hasLength(1));
    });

    test('a second tap while one waits replaces it, not adds to it', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = SosQueue(repo, prefs, retryEvery: const Duration(hours: 1));
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 1);
      await q.alert(lat: 2, lng: 2);
      expect(q.waiting, hasLength(1));
      expect(q.waiting.single.lat, 2);
    });
  });

  group('SOS sheet', () {
    testWidgets('Call 112 dials 112 and says it is the phone calling', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      expect(find.text('Call 112'), findsOneWidget);
      expect(find.text('This calls 112 from your phone'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('call-112')));
      expect(ctx.opened.map((u) => u.toString()), ['tel:112']);
    });

    testWidgets('Alert Deligro says "ops have been alerted" only once the server confirmed', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo);
      await _openSheet(tester);
      expect(find.text(sosSentText), findsNothing);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(find.text('Deligro ops have been alerted'), findsOneWidget);
      expect(find.byKey(const Key('sos-sent')), findsOneWidget);
      expect(find.text(sosQueuedText), findsNothing);
      // The live location went with it.
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.7189, 81.5301));
    });

    testWidgets('no internet: the calls still work, the alert says not sent, then goes when the signal is back', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final ctx = await _pump(tester, safety: repo, prefs: {
        // The numbers were saved the last time the rider had signal.
        'emergency_contact_v1': '{"name":"Sunita","phone":"+919123456780","relation":"Wife"}',
        'support_contact_v1': '{"phone":"+91 98765 43210","whatsapp":null}',
      });
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));

      // Never claims it was sent.
      expect(find.text('Not sent yet — trying again'), findsOneWidget);
      expect(find.text(sosSentText), findsNothing);
      expect(find.byKey(const Key('sos-sent')), findsNothing);

      // The phone calls do not need the internet.
      await _tap(tester, find.byKey(const Key('call-112')));
      await _tap(tester, find.byKey(const Key('call-emergency-contact')));
      await _tap(tester, find.byKey(const Key('call-support-sos')));
      expect(ctx.opened.map((u) => u.toString()), ['tel:112', 'tel:+919123456780', 'tel:+919876543210']);

      // Signal returns; the rider has moved. The next try on the 15 s beat goes
      // through, with the last known location.
      repo.error = null;
      ctx.container.read(latestFixProvider.notifier).set((lat: 21.8, lng: 81.6, at: DateTime.now()));
      await tester.pump(const Duration(seconds: 15));
      await _settle(tester);
      expect(find.text('Deligro ops have been alerted'), findsOneWidget);
      expect(find.text('Not sent yet — trying again'), findsNothing);
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.8, 81.6));
    });

    testWidgets('the phone remembers a pending alert: a new queue picks it up at start', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final ctx = await _pump(tester, safety: repo);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(ctx.container.read(sosQueueProvider).waiting, hasLength(1));
      final stored = (await SharedPreferences.getInstance()).getString(SosQueue.key);
      expect(stored, isNotNull);
      expect(stored, contains('21.7189'));
      ctx.container.read(sosQueueProvider).dispose(); // its retry timer must not outlive the test
    });

    testWidgets('with no GPS reading, the phone\'s last known position is sent', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo, fix: null, lastKnown: (lat: 20.1, lng: 80.2));
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect((repo.sent.single.lat, repo.sent.single.lng), (20.1, 80.2));
    });

    testWidgets('with no position at all, the alert still goes, without one', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo, fix: null);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(find.text(sosSentText), findsOneWidget);
      expect(repo.sent.single.lat, isNull);
    });

    testWidgets('no emergency contact: the row is hidden and a link adds one', (tester) async {
      await _pump(tester, safety: _Safety(contact: null));
      await _openSheet(tester);
      expect(find.byKey(const Key('call-emergency-contact')), findsNothing);
      expect(find.byKey(const Key('no-emergency-contact')), findsOneWidget);
      expect(find.text('No emergency contact saved'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('add-emergency-contact')));
      expect(find.text('PROFILE PAGE'), findsOneWidget);
    });

    testWidgets('the emergency contact is called by name', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      expect(find.text('Call Sunita'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('call-emergency-contact')));
      expect(ctx.opened.single.toString(), 'tel:+919123456780');
    });

    testWidgets('Call Deligro support is there when Deligro has a number', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('call-support-sos')));
      expect(ctx.opened.single.toString(), 'tel:+919876543210');
    });

    testWidgets('no sentence in any state claims emergency services were reached', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo);
      await _openSheet(tester);
      final texts = <String>[_allText(tester)];
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      texts.add(_allText(tester));
      repo.error = ApiException(0, 'network');
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      texts.add(_allText(tester));
      for (final t in texts) {
        expect(_claim.hasMatch(t), isFalse, reason: t);
      }
      expect(texts.last, contains('Not sent yet'));
      ctx.container.read(sosQueueProvider).dispose();
    });
  });

  group('Safety screen', () {
    testWidgets('has the same four actions and the five report forms', (tester) async {
      await _pump(tester, start: '/safety');
      expect(find.byKey(const Key('call-112')), findsOneWidget);
      expect(find.byKey(const Key('alert-deligro')), findsOneWidget);
      expect(find.byKey(const Key('call-emergency-contact')), findsOneWidget);
      for (final k in ['unsafe_situation', 'accident', 'vehicle_breakdown', 'harassment_threat', 'suspicious_order_location']) {
        await tester.ensureVisible(find.byKey(Key('report-$k')));
        expect(find.byKey(Key('report-$k')), findsOneWidget, reason: k);
      }
      expect(find.text('Harassment or threats'), findsOneWidget);
    });

    testWidgets('a report goes with its kind, note, photos and location, then says ops were alerted', (tester) async {
      final repo = _Safety();
      await _pump(tester, start: '/safety', safety: repo, gallery: (limit) => [File('a.jpg'), File('b.png')]);
      await _tap(tester, find.byKey(const Key('report-harassment_threat')));
      expect(find.byKey(const Key('incident-location')), findsOneWidget);
      expect(find.text('Your location is sent with the report.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('incident-note')), 'Two men blocked the road');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('add-photo')));
      await _tap(tester, find.byKey(const Key('photo-gallery')));
      await _tap(tester, find.byKey(const Key('send-incident')));

      final s = repo.sent.single;
      expect(s.kind, SosKind.harassmentThreat);
      expect(s.note, 'Two men blocked the road');
      expect(s.photos, 2);
      expect((s.lat, s.lng), (21.7189, 81.5301));
      expect(find.text('Report sent. Deligro ops have been alerted.'), findsOneWidget);
    });

    testWidgets('a report that does not reach the server says not sent, keeps the form, and never claims alerted', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      await _pump(tester, start: '/safety', safety: repo);
      await _tap(tester, find.byKey(const Key('report-accident')));
      await tester.enterText(find.byKey(const Key('incident-note')), 'Slipped on oil');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('send-incident')));
      expect(find.byKey(const Key('incident-error')), findsOneWidget);
      expect(find.textContaining('Not sent'), findsOneWidget);
      expect(find.textContaining('call 112'), findsOneWidget);
      expect(find.byKey(const Key('incident-sent')), findsNothing);
      expect(find.textContaining('have been alerted'), findsNothing);
      expect(tester.widget<TextField>(find.byKey(const Key('incident-note'))).controller!.text, 'Slipped on oil');
    });

    testWidgets('a report with no position says so and still goes', (tester) async {
      final repo = _Safety();
      await _pump(tester, start: '/safety', safety: repo, fix: null);
      await _tap(tester, find.byKey(const Key('report-vehicle_breakdown')));
      expect(find.textContaining("location isn't available"), findsOneWidget);
      await _tap(tester, find.byKey(const Key('send-incident')));
      expect(repo.sent.single.lat, isNull);
      expect(find.byKey(const Key('incident-sent')), findsOneWidget);
    });
  });

  group('wording', () {
    test('no string in the safety feature, its state or its queue claims emergency services were reached', () {
      final files = [
        ...Directory('lib/features/safety').listSync().whereType<File>(),
        File('lib/state/safety.dart'),
        File('lib/core/sos_queue.dart'),
        File('lib/data/safety_repository.dart'),
        File('lib/data/fixtures/fixture_support.dart'),
      ];
      expect(files, isNotEmpty);
      final literal = RegExp(r'''\x27([^\x27\n]{12,})\x27|"([^"\n]{12,})"''');
      final offenders = <String>[];
      for (final f in files) {
        for (final m in literal.allMatches(f.readAsStringSync())) {
          final text = m.group(1) ?? m.group(2)!;
          if (_claim.hasMatch(text)) offenders.add('${f.path}: $text');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('the three sentences are exactly the ones the requirements name', () {
      expect(call112Note, 'This calls 112 from your phone');
      expect(sosSentText, 'Deligro ops have been alerted');
      expect(sosQueuedText, 'Not sent yet — trying again');
    });
  });

  group('Light, dark and 1.3x text', () {
    for (final scale in [1.0, 1.3]) {
      for (final dark in [false, true]) {
        for (final page in ['sheet', 'safety', 'report']) {
          testWidgets('$page at ${scale}x ${dark ? 'dark' : 'light'}', (tester) async {
            await _pump(
              tester,
              start: page == 'sheet' ? '/host' : '/safety',
              brightness: dark ? Brightness.dark : Brightness.light,
              textScale: scale,
            );
            if (page == 'sheet') {
              await _openSheet(tester);
              await _tap(tester, find.byKey(const Key('alert-deligro')));
            }
            if (page == 'report') {
              await _tap(tester, find.byKey(const Key('report-unsafe_situation')));
            }
            expect(tester.takeException(), isNull);
          });
        }
      }
    }
  });
}
