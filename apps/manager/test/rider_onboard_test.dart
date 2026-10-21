import 'dart:convert';

import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/riders/rider_onboard_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:deligro_manager/state/rider_onboard_draft.dart';
import 'package:deligro_manager/widgets/document_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'rider_helpers.dart';

const _onboarder = {...riderViewer, 'manager.riders.onboard'};

final _picker = documentPickerProvider.overrideWithValue(
  (BuildContext _) async => XFile.fromData(Uint8List.fromList(List.filled(64, 1)), name: 'doc.jpg', path: 'doc.jpg'),
);

Future<RiderFakes> _pump(WidgetTester tester, {RiderFakes? fakes, Map<String, Object> prefs = const {}}) async {
  final f = fakes ?? RiderFakes();
  await pumpRider(
    tester,
    const RiderOnboardScreen(),
    fakes: f,
    permissions: _onboarder,
    prefs: prefs,
    extra: [_picker],
    size: const Size(420, 1000),
  );
  return f;
}

Finder _next() => find.byKey(const Key('onboard-next'));

bool _enabled(WidgetTester tester, Finder f) => tester.widget<ButtonStyleButton>(f).onPressed != null;

Future<void> _type(WidgetTester tester, String key, String text) async {
  await tester.enterText(find.byKey(Key(key)), text);
  await tester.pump();
}

Future<void> _fillStep1(WidgetTester tester, {String mobile = '9876543210'}) async {
  await _type(tester, 'rider-name', 'Ravi Kumar');
  await _type(tester, 'rider-mobile', mobile);
}

Future<void> _goNext(WidgetTester tester) async {
  await tester.ensureVisible(_next());
  await tester.tap(_next());
  await tester.pumpAndSettle();
}

/// Steps 1–3 filled with valid values; ends on the Documents step.
Future<void> _toDocuments(WidgetTester tester) async {
  await _fillStep1(tester);
  await _goNext(tester);
  await _goNext(tester);
  await _goNext(tester);
}

void main() {
  testWidgets('Next stays off until the step is valid; a 9-digit mobile is refused with a message', (tester) async {
    await _pump(tester);
    expect(_enabled(tester, _next()), isFalse);
    await _fillStep1(tester, mobile: '987654321');
    expect(_enabled(tester, _next()), isFalse);
    expect(find.text('Enter the 10-digit mobile number.'), findsOneWidget);
    await _type(tester, 'rider-mobile', '9876543210');
    expect(_enabled(tester, _next()), isTrue);
  });

  testWidgets('a 4-digit pincode is refused with a message', (tester) async {
    await _pump(tester);
    await _fillStep1(tester);
    await _goNext(tester);
    await _goNext(tester);
    await _type(tester, 'rider-pincode', '4913');
    expect(find.text('A pincode has 6 digits.'), findsOneWidget);
    expect(_enabled(tester, _next()), isFalse);
    await _type(tester, 'rider-pincode', '491335');
    expect(_enabled(tester, _next()), isTrue);
  });

  testWidgets('the only zone is chosen already', (tester) async {
    await _pump(tester);
    expect(find.text('Bemetara'), findsOneWidget);
  });

  testWidgets('RC, insurance and PUC are asked for only when the rider owns the vehicle', (tester) async {
    await _pump(tester);
    await _fillStep1(tester);
    await _goNext(tester);
    await _goNext(tester);
    await _goNext(tester);
    expect(find.byKey(const Key('doc-pick-vehicle_rc')), findsNothing);
    expect(find.byKey(const Key('doc-pick-driving_licence')), findsOneWidget);
    await tester.tap(find.byKey(const Key('onboard-back')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboard-back')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('The rider'));
    await tester.pumpAndSettle();
    await _goNext(tester);
    await _goNext(tester);
    expect(find.byKey(const Key('doc-pick-vehicle_rc')), findsOneWidget);
    expect(find.byKey(const Key('doc-pick-insurance')), findsOneWidget);
    expect(find.byKey(const Key('doc-pick-puc')), findsOneWidget);
  });

  testWidgets('a double tap on Submit onboards once', (tester) async {
    final fakes = await _pump(tester);
    await _toDocuments(tester);
    await _goNext(tester);
    final submit = find.byKey(const Key('onboard-submit'));
    await tester.tap(submit);
    await tester.tap(submit, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(fakes.riders.onboardCalls, hasLength(1));
    expect(fakes.riders.onboardCalls.single.draft.zoneId, 'z1');
    expect(fakes.riders.onboardCalls.single.draft.mobile, '9876543210');
  });

  testWidgets('phone_taken goes back to the first step with the reason', (tester) async {
    final fakes = RiderFakes();
    fakes.riders.onboardOutcomes.add(const Refused('phone_taken'));
    await _pump(tester, fakes: fakes);
    await _toDocuments(tester);
    await _goNext(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.text('This mobile number already has an account.'), findsOneWidget);
    expect(find.byKey(const Key('rider-mobile')), findsOneWidget);
  });

  testWidgets('a network fault retries with the same id', (tester) async {
    final fakes = RiderFakes();
    fakes.riders.onboardError = ApiException(500, 'boom');
    await _pump(tester, fakes: fakes);
    await _toDocuments(tester);
    await _goNext(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    final calls = fakes.riders.onboardCalls;
    expect(calls, hasLength(2));
    expect(calls[1].clientActionId, calls[0].clientActionId);
  });

  testWidgets('the generated password is shown once, with Copy', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await _pump(tester);
    await _toDocuments(tester);
    await _goNext(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Gen-erated9'), findsOneWidget);
    expect(find.text('This password will not be shown again.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('cred-copy')));
    await tester.pump();
    expect(copied, contains('Gen-erated9'));
  });

  testWidgets('a failed upload offers Retry for that file only', (tester) async {
    final fakes = RiderFakes();
    fakes.riders.uploadResults.addAll([ApiException(500, 'boom')]);
    await _pump(tester, fakes: fakes);
    await _toDocuments(tester);
    await tester.tap(find.byKey(const Key('doc-pick-aadhaar')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('doc-pick-photo')));
    await tester.pumpAndSettle();
    await _goNext(tester);
    await tester.tap(find.byKey(const Key('onboard-submit')));
    await tester.pumpAndSettle();
    expect(fakes.riders.uploadCalls.map((c) => c.type), [RiderDocType.aadhaar, RiderDocType.photo]);
    expect(find.byKey(const Key('upload-retry-aadhaar')), findsOneWidget);
    expect(find.byKey(const Key('upload-retry-photo')), findsNothing);
    final firstId = fakes.riders.uploadCalls.first.clientActionId;
    await tester.tap(find.byKey(const Key('upload-retry-aadhaar')));
    await tester.pumpAndSettle();
    expect(fakes.riders.uploadCalls, hasLength(3));
    expect(fakes.riders.uploadCalls.last.type, RiderDocType.aadhaar);
    expect(fakes.riders.uploadCalls.last.clientActionId, firstId);
    expect(find.byKey(const Key('upload-retry-aadhaar')), findsNothing);
  });

  testWidgets('the draft is saved on the phone (without the password) and comes back', (tester) async {
    await _pump(tester);
    await _fillStep1(tester);
    await _type(tester, 'rider-password', 'secret-pass-1');
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(riderOnboardDraftKey);
    expect(saved, isNotNull);
    expect(saved, contains('Ravi Kumar'));
    expect(saved, isNot(contains('secret-pass-1')));
    await _pump(tester, prefs: {riderOnboardDraftKey: saved!});
    expect(find.text('Ravi Kumar'), findsOneWidget);
    expect((jsonDecode(saved) as Map)['mobile'], '9876543210');
  });
}
