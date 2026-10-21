import 'dart:convert';

import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/vendors/onboard/onboard_flow.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:deligro_manager/state/onboard_draft.dart';
import 'package:deligro_manager/widgets/document_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'vp_helpers.dart';

const _onboarder = {...vendorViewer, 'manager.vendors.onboard'};

Future<FakeVendorsRepository> _flow(
  WidgetTester tester, {
  FakeVendorsRepository? repo,
  Map<String, Object> prefs = const {},
  List<XFile> picks = const [],
}) async {
  final fake = repo ?? FakeVendorsRepository();
  final queue = [...picks];
  await pumpVp(
    tester,
    const OnboardFlow(),
    vendors: fake,
    permissions: _onboarder,
    prefs: prefs,
    size: const Size(400, 1000),
    extra: [
      documentPickerProvider.overrideWithValue((_) async => queue.isEmpty ? null : queue.removeAt(0)),
      currentLocationProvider.overrideWithValue(() async => const LatLng(21.71, 81.53)),
    ],
  );
  return fake;
}

bool _nextEnabled(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(const Key('onboard-next'))).onPressed != null;

Future<void> _next(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('onboard-next')));
  await tester.pumpAndSettle();
}

/// Fills Shop, Owner, Location and Hours and lands on Documents.
Future<void> _fillToDocuments(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Spice Hub');
  await tester.pump();
  await _next(tester);
  await tester.enterText(find.byKey(const Key('onboard-owner-name')), 'Anil Verma');
  await tester.enterText(find.byKey(const Key('onboard-mobile')), '9812345678');
  await tester.enterText(find.byKey(const Key('onboard-email')), 'anil@spicehub.in');
  await tester.pump();
  await _next(tester);
  await tester.enterText(find.byKey(const Key('onboard-address')), 'Station Road, Bemetara');
  await tester.tap(find.byKey(const Key('onboard-use-location')));
  await tester.pumpAndSettle();
  await _next(tester);
  await _next(tester); // Hours are optional.
}

void main() {
  testWidgets('Next stays off until the step is valid; a 9-digit mobile is refused in words', (tester) async {
    await _flow(tester);
    expect(_nextEnabled(tester), isFalse);
    await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Spice Hub');
    await tester.pump();
    expect(_nextEnabled(tester), isTrue);
    await _next(tester);

    await tester.enterText(find.byKey(const Key('onboard-owner-name')), 'Anil Verma');
    await tester.enterText(find.byKey(const Key('onboard-mobile')), '981234567');
    await tester.enterText(find.byKey(const Key('onboard-email')), 'anil@spicehub.in');
    await tester.pump();
    expect(_nextEnabled(tester), isFalse);
    expect(find.text('Enter a 10-digit mobile number'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('onboard-mobile')), '9812345678');
    await tester.pump();
    expect(_nextEnabled(tester), isTrue);
  });

  testWidgets('the zone defaults to the only zone the manager has', (tester) async {
    await _flow(tester);
    expect(find.text('Bemetara'), findsWidgets);
    await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Spice Hub');
    await tester.pump();
    expect(_nextEnabled(tester), isTrue, reason: 'no zone to pick by hand');
  });

  testWidgets('submitting twice sends one onboarding request', (tester) async {
    final fake = await _flow(tester);
    await _fillToDocuments(tester);
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.tap(find.byKey(const Key('onboard-submit')), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(fake.onboardCalls, hasLength(1));
    final body = fake.onboardCalls.single.draft.toRequest(fake.onboardCalls.single.clientActionId);
    expect(body['zoneId'], 'z1');
    expect(body['mobile'], '9812345678');
    expect(body['lat'], 21.71);
  });

  testWidgets('a taken mobile number goes back to the Owner step and says so', (tester) async {
    final fake = FakeVendorsRepository()..onboardOutcomes.add(const Refused('phone_taken'));
    await _flow(tester, repo: fake);
    await _fillToDocuments(tester);
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('onboard-mobile')), findsOneWidget);
    expect(find.text('This mobile number already has an account'), findsOneWidget);
  });

  testWidgets('generated credentials are shown once, with Copy', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final fake = FakeVendorsRepository()
      ..onboardOutcomes.add(const Applied(
          OnboardResult(id: 'v-new', slug: 'spice-hub', email: 'anil@spicehub.in', password: 'Kx7-pq92-ab')));
    await _flow(tester, repo: fake);
    await _fillToDocuments(tester);
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Kx7-pq92-ab'), findsOneWidget);
    expect(find.textContaining('will not be shown again'), findsOneWidget);
    await tester.tap(find.byKey(const Key('copy-password')));
    await tester.pump();
    expect(copied, contains('Kx7-pq92-ab'));
  });

  testWidgets('a failed document upload offers Retry for that file only', (tester) async {
    final fake = FakeVendorsRepository()..uploadResults.addAll([ApiException(0, 'network')]);
    await _flow(tester, repo: fake, picks: [
      XFile.fromData(Uint8List.fromList(utf8.encode('pdf')), name: 'fssai.pdf', path: 'fssai.pdf'),
      XFile.fromData(Uint8List.fromList(utf8.encode('img')), name: 'cheque.jpg', path: 'cheque.jpg'),
    ]);
    await _fillToDocuments(tester);
    await tester.tap(find.byKey(const Key('onboard-doc-add-fssai')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboard-doc-add-bank_proof')));
    await tester.pumpAndSettle();
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(fake.uploadCalls.map((u) => u.name), ['fssai.pdf', 'cheque.jpg']);
    expect(find.byKey(const Key('upload-retry-fssai')), findsOneWidget);
    expect(find.byKey(const Key('upload-retry-bank_proof')), findsNothing);
    final firstId = fake.uploadCalls.first.clientActionId;
    await tester.tap(find.byKey(const Key('upload-retry-fssai')));
    await tester.pumpAndSettle();
    expect(fake.uploadCalls, hasLength(3));
    expect(fake.uploadCalls.last.name, 'fssai.pdf');
    expect(fake.uploadCalls.last.clientActionId, firstId, reason: 'a retry is the same upload');
    expect(find.byKey(const Key('upload-retry-fssai')), findsNothing);
  });

  testWidgets('the draft is kept on the phone and comes back', (tester) async {
    await _flow(tester);
    await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Green Leaf Cafe');
    await tester.pump(const Duration(milliseconds: 600));
    final saved = (await SharedPreferences.getInstance()).getString(onboardDraftKey);
    expect(saved, isNotNull);
    expect(jsonDecode(saved!)['shopName'], 'Green Leaf Cafe');
    expect(jsonDecode(saved)['password'], isNull);

    await tester.pumpWidget(const SizedBox());
    await _flow(tester, prefs: {onboardDraftKey: saved});
    expect(find.text('Green Leaf Cafe'), findsOneWidget);
  });

  testWidgets('a replayed onboarding without credentials says they were shown once', (tester) async {
    final fake = FakeVendorsRepository()
      ..onboardOutcomes.add(const Applied(OnboardResult(id: 'v-new', slug: 'spice-hub')));
    await _flow(tester, repo: fake);
    await _fillToDocuments(tester);
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.textContaining('shown once when this vendor was first added'), findsOneWidget);
  });

  testWidgets('an id already used elsewhere (stale) starts a fresh attempt and says why', (tester) async {
    final fake = FakeVendorsRepository()..onboardOutcomes.add(const Refused('stale'));
    await _flow(tester, repo: fake);
    await _fillToDocuments(tester);
    await _next(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.textContaining('already sent'), findsOneWidget);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(fake.onboardCalls, hasLength(2));
    expect(fake.onboardCalls[1].clientActionId, isNot(fake.onboardCalls[0].clientActionId));
  });
}
